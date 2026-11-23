/**
 * Replication & Load Balancing Module
 *
 * Implements weighted peer selection (Section 11) and dynamic Reed-Solomon
 * shard health auditing + self-healing replication (Section 6).
 */

import { base64ToBytes, bytesToBase64, decodeReedSolomon, encodeReedSolomon, sha256Hex } from '../crypto/CryptoModule';
import type { P2PNetworkModule } from '../p2p/P2PNetworkModule';
import type { DistributedStorageModule } from '../storage/DistributedStorageModule';
import type { FileManifest, PeerInfo } from '../types';

export class ReplicationModule {
  private lastAuditAt: number | null = null;
  private repairedCount = 0;
  private healthyShards = 0;
  private totalShards = 0;
  private pendingProbes = new Map<string, (exists: boolean) => void>();
  private pendingShardReads = new Map<string, (bytes: Uint8Array | null) => void>();

  constructor(
    private p2p: P2PNetworkModule,
    private storage: DistributedStorageModule
  ) {}

  getHealthSnapshot(trackedFilesCount: number) {
    return {
      trackedFiles: trackedFilesCount,
      healthyShards: this.healthyShards,
      totalShards: this.totalShards,
      lastAuditAt: this.lastAuditAt,
      repairedCount: this.repairedCount,
    };
  }

  /**
   * Scores peers for distributed shard placement using multi-factor load balancing:
   * - Free space ratio & absolute available bytes
   * - Peer reputation (0..100)
   * - Always-on stability & battery/charging state
   * - RTT latency & bandwidth budget
   * Prevents concentration of data on a small subset of nodes.
   */
  rankStoragePeers(peers: PeerInfo[], requiredBytes: number): PeerInfo[] {
    const now = Date.now();
    return peers
      .filter(
        (p) =>
          p.connected &&
          p.capabilities.freeStorageBytes >= requiredBytes &&
          p.reputation >= 35
      )
      .map((peer) => {
        const cap = peer.capabilities;
        const freeRatio =
          cap.maxStorageBytes > 0 ? cap.freeStorageBytes / cap.maxStorageBytes : 0.5;
        const uptimeHours = Math.min(24, (now - peer.connectedAt) / 3600000);
        const batteryScore =
          cap.batteryLevel === null ? 1.0 : cap.charging ? 1.0 : cap.batteryLevel;
        const rttScore = peer.rttMs === null ? 0.7 : Math.max(0.1, 1 - peer.rttMs / 1000);
        const alwaysOnBonus = cap.alwaysOnNode ? 25 : 0;

        const score =
          freeRatio * 35 +
          (peer.reputation / 100) * 30 +
          batteryScore * 15 +
          rttScore * 10 +
          uptimeHours * 0.5 +
          alwaysOnBonus;

        return { peer, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.peer);
  }

  handleProbeAck(shardId: string, peerId: string, exists: boolean): void {
    const key = `${peerId}:${shardId}`;
    const resolver = this.pendingProbes.get(key);
    if (resolver) {
      this.pendingProbes.delete(key);
      resolver(exists);
    }
  }

  handleShardDataForRepair(shardId: string, peerId: string, bytes: Uint8Array | null): void {
    const key = `${peerId}:${shardId}`;
    const resolver = this.pendingShardReads.get(key);
    if (resolver) {
      this.pendingShardReads.delete(key);
      resolver(bytes);
    }
  }

  private probePeerShard(peerId: string, shardId: string, timeoutMs = 1200): Promise<boolean> {
    if (peerId === this.p2p.myPeerId) {
      return this.storage.hasForeignShard(shardId);
    }
    return new Promise((resolve) => {
      const key = `${peerId}:${shardId}`;
      const timer = setTimeout(() => {
        this.pendingProbes.delete(key);
        resolve(false);
      }, timeoutMs);
      this.pendingProbes.set(key, (exists) => {
        clearTimeout(timer);
        resolve(exists);
      });
      const env = this.p2p.createEnvelope('SHARD_PROBE', { shardId }, peerId);
      const ok = this.p2p.sendEnvelope(env, peerId);
      if (!ok) {
        clearTimeout(timer);
        this.pendingProbes.delete(key);
        resolve(false);
      }
    });
  }

  private fetchShardBytes(peerId: string, shardId: string, timeoutMs = 2000): Promise<Uint8Array | null> {
    if (peerId === this.p2p.myPeerId) {
      return this.storage.getForeignShard(shardId);
    }
    return new Promise((resolve) => {
      const key = `${peerId}:${shardId}`;
      const timer = setTimeout(() => {
        this.pendingShardReads.delete(key);
        resolve(null);
      }, timeoutMs);
      this.pendingShardReads.set(key, (bytes) => {
        clearTimeout(timer);
        resolve(bytes);
      });
      const env = this.p2p.createEnvelope('SHARD_GET', { shardId }, peerId);
      const ok = this.p2p.sendEnvelope(env, peerId);
      if (!ok) {
        clearTimeout(timer);
        this.pendingShardReads.delete(key);
        resolve(null);
      }
    });
  }

  /**
   * Audits tracked FileManifests across live P2P peers.
   * If a node holding a shard went offline, reconstructs the lost shard using
   * Reed-Solomon erasure decoding and redistributes it to healthy nodes.
   */
  async auditAndRepairManifests(
    manifests: FileManifest[],
    myDidHash: string,
    onManifestUpdated: (updated: FileManifest) => void
  ): Promise<{ healthy: number; total: number; repaired: number }> {
    let total = 0;
    let healthy = 0;
    let repairedThisPass = 0;

    const connectedPeers = this.p2p.getConnectedPeers();

    for (const manifest of manifests) {
      const availableForRecovery: Array<{ index: number; bytes: Uint8Array }> = [];
      const missingShards: number[] = [];
      let manifestChanged = false;

      for (const shard of manifest.shards) {
        total++;
        let aliveHolder: string | null = null;
        for (const holder of shard.holders) {
          if (holder === this.p2p.myPeerId || connectedPeers.some((p) => p.peerId === holder)) {
            const exists = await this.probePeerShard(holder, shard.shardId);
            if (exists) {
              aliveHolder = holder;
              break;
            }
          }
        }

        if (aliveHolder) {
          healthy++;
          if (availableForRecovery.length < manifest.dataShards) {
            const bytes = await this.fetchShardBytes(aliveHolder, shard.shardId);
            if (bytes && sha256Hex(bytes) === shard.shardId) {
              availableForRecovery.push({ index: shard.index, bytes });
            }
          }
        } else {
          missingShards.push(shard.index);
        }
      }

      if (
        missingShards.length > 0 &&
        availableForRecovery.length >= manifest.dataShards
      ) {
        try {
          const recoveredCiphertext = decodeReedSolomon(
            availableForRecovery,
            manifest.dataShards,
            manifest.encryptedSize
          );
          const reEncoded = encodeReedSolomon(
            recoveredCiphertext,
            manifest.dataShards,
            manifest.parityShards
          );

          const rankedPeers = this.rankStoragePeers(connectedPeers, manifest.shardSize);
          for (const missingIdx of missingShards) {
            const targetShard = manifest.shards[missingIdx];
            const shardBytes = reEncoded.shards[missingIdx];
            if (!targetShard || !shardBytes) continue;

            const candidate = rankedPeers.find(
              (p) => !targetShard.holders.includes(p.peerId)
            );
            if (candidate) {
              const putEnv = this.p2p.createEnvelope(
                'SHARD_PUT',
                {
                  shardId: targetShard.shardId,
                  ownerDidHint: myDidHash,
                  dataBase64: bytesToBase64(shardBytes),
                },
                candidate.peerId
              );
              if (this.p2p.sendEnvelope(putEnv, candidate.peerId)) {
                targetShard.holders = [
                  ...targetShard.holders.filter((h) =>
                    connectedPeers.some((p) => p.peerId === h)
                  ),
                  candidate.peerId,
                ];
                repairedThisPass++;
                this.repairedCount++;
                healthy++;
                manifestChanged = true;
              }
            }
          }
        } catch {
          // Insufficient healthy shards for recovery right now
        }
      }

      if (manifestChanged) {
        onManifestUpdated(manifest);
      }
    }

    this.healthyShards = healthy;
    this.totalShards = total;
    this.lastAuditAt = Date.now();
    return { healthy, total, repaired: repairedThisPass };
  }

  decodeIncomingShardPayload(dataBase64: string): Uint8Array {
    return base64ToBytes(dataBase64);
  }
}
