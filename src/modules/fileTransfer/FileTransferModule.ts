/**
 * File Transfer Module
 *
 * Implements distributed E2EE file upload and recovery (Section 6 & 8):
 * 1. Encrypts raw file bytes on sender's device with a unique 256-bit AES-GCM key.
 * 2. Encodes ciphertext via GF(2^8) Reed-Solomon (k=4 data + m=2 parity shards).
 * 3. Computes SHA-256 content ID for every shard.
 * 4. Distributes shards across ranked P2P storage nodes (with local vault fallback
 *    when fewer than k+m external peers are currently connected).
 * 5. Publishes shard location records to the Kademlia DHT.
 * 6. On download: fetches any k valid shards in parallel, verifies SHA-256,
 *    reconstructs missing shards with Reed-Solomon, and decrypts locally.
 */

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decodeReedSolomon,
  encodeReedSolomon,
  hexToBytes,
  randomBytes,
  sha256Hex,
} from '../crypto/CryptoModule';
import type { DiscoveryModule } from '../discovery/DiscoveryModule';
import { shardToDhtKey } from '../discovery/DiscoveryModule';
import type { P2PNetworkModule } from '../p2p/P2PNetworkModule';
import type { ReplicationModule } from '../replication/ReplicationModule';
import type { SecurityModule } from '../security/SecurityModule';
import type { DistributedStorageModule } from '../storage/DistributedStorageModule';
import type {
  FileManifest,
  FileShardDescriptor,
  LocalIdentitySecret,
  NodeSettings,
} from '../types';

export interface ShardTransferProgress {
  completed: number;
  total: number;
  phase: 'encrypting' | 'encoding' | 'distributing' | 'fetching' | 'recovering' | 'decrypting' | 'done';
}

export class FileTransferModule {
  private pendingPutAcks = new Map<string, (accepted: boolean) => void>();
  private pendingShardGets = new Map<string, (bytes: Uint8Array | null) => void>();

  constructor(
    private p2p: P2PNetworkModule,
    private storage: DistributedStorageModule,
    private replication: ReplicationModule,
    private discovery: DiscoveryModule,
    private security: SecurityModule
  ) {}

  handleShardPutAck(shardId: string, peerId: string, accepted: boolean): void {
    const key = `${peerId}:${shardId}`;
    const cb = this.pendingPutAcks.get(key);
    if (cb) {
      this.pendingPutAcks.delete(key);
      cb(accepted);
    }
  }

  handleShardData(shardId: string, peerId: string, dataBase64: string | null): void {
    const key = `${peerId}:${shardId}`;
    const cb = this.pendingShardGets.get(key);
    if (!cb) return;
    this.pendingShardGets.delete(key);

    if (!dataBase64) {
      cb(null);
      return;
    }

    try {
      const bytes = base64ToBytes(dataBase64);
      if (!this.security.verifyShardIntegrity(shardId, bytes)) {
        this.security.adjustReputation(
          peerId,
          -35,
          `Узел вернул повреждённый или подменённый блок ${shardId.slice(0, 10)}`
        );
        cb(null);
        return;
      }
      this.security.adjustReputation(peerId, 2);
      cb(bytes);
    } catch {
      cb(null);
    }
  }

  private sendShardPut(
    peerId: string,
    shardId: string,
    ownerDidHint: string,
    bytes: Uint8Array,
    timeoutMs = 3000
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const key = `${peerId}:${shardId}`;
      const timer = setTimeout(() => {
        this.pendingPutAcks.delete(key);
        resolve(false);
      }, timeoutMs);

      this.pendingPutAcks.set(key, (accepted) => {
        clearTimeout(timer);
        resolve(accepted);
      });

      const env = this.p2p.createEnvelope(
        'SHARD_PUT',
        {
          shardId,
          ownerDidHint,
          dataBase64: bytesToBase64(bytes),
        },
        peerId
      );

      if (!this.p2p.sendEnvelope(env, peerId)) {
        clearTimeout(timer);
        this.pendingPutAcks.delete(key);
        resolve(false);
      }
    });
  }

  private requestShardFromPeer(
    peerId: string,
    shardId: string,
    timeoutMs = 3500
  ): Promise<Uint8Array | null> {
    if (peerId === this.p2p.myPeerId) {
      return this.storage.getForeignShard(shardId);
    }
    return new Promise((resolve) => {
      const key = `${peerId}:${shardId}`;
      const timer = setTimeout(() => {
        this.pendingShardGets.delete(key);
        resolve(null);
      }, timeoutMs);

      this.pendingShardGets.set(key, (bytes) => {
        clearTimeout(timer);
        resolve(bytes);
      });

      const env = this.p2p.createEnvelope('SHARD_GET', { shardId }, peerId);
      if (!this.p2p.sendEnvelope(env, peerId)) {
        clearTimeout(timer);
        this.pendingShardGets.delete(key);
        resolve(null);
      }
    });
  }

  async uploadFile(
    file: { name: string; type: string; bytes: Uint8Array },
    secret: LocalIdentitySecret,
    settings: NodeSettings,
    onProgress?: (p: ShardTransferProgress) => void
  ): Promise<FileManifest> {
    const dataShards = 4;
    const parityShards = 2;
    const totalShards = dataShards + parityShards;

    onProgress?.({ completed: 0, total: totalShards, phase: 'encrypting' });

    const fileKey = randomBytes(32);
    const { ivHex, ciphertext } = await aesGcmEncrypt(fileKey, file.bytes);

    onProgress?.({ completed: 0, total: totalShards, phase: 'encoding' });
    const rs = encodeReedSolomon(ciphertext, dataShards, parityShards);

    const ownerDidHint = sha256Hex(secret.did).slice(0, 16);
    const connectedPeers = this.p2p.getConnectedPeers();
    const rankedPeers = this.replication.rankStoragePeers(connectedPeers, rs.shardSize);

    const descriptors: FileShardDescriptor[] = [];

    onProgress?.({ completed: 0, total: totalShards, phase: 'distributing' });

    for (let i = 0; i < rs.shards.length; i++) {
      const shardBytes = rs.shards[i];
      const shardId = sha256Hex(shardBytes);
      const holders: string[] = [];

      // Distribute across distinct remote peers round-robin, plus redundant copy if possible
      if (rankedPeers.length > 0) {
        const primaryPeer = rankedPeers[i % rankedPeers.length];
        const okPrimary = await this.sendShardPut(
          primaryPeer.peerId,
          shardId,
          ownerDidHint,
          shardBytes
        );
        if (okPrimary) holders.push(primaryPeer.peerId);

        if (rankedPeers.length > 1) {
          const backupPeer = rankedPeers[(i + 1) % rankedPeers.length];
          if (backupPeer.peerId !== primaryPeer.peerId) {
            const okBackup = await this.sendShardPut(
              backupPeer.peerId,
              shardId,
              ownerDidHint,
              shardBytes
            );
            if (okBackup) holders.push(backupPeer.peerId);
          }
        }
      }

      // Ensure at least 1 copy exists (local node vault fallback when network has < 2 peers)
      if (holders.length === 0) {
        const localRes = await this.storage.putForeignShard(
          shardId,
          shardBytes,
          ownerDidHint,
          settings
        );
        if (localRes.accepted) {
          holders.push(this.p2p.myPeerId);
        }
      }

      descriptors.push({
        index: i,
        shardId,
        sizeBytes: shardBytes.length,
        holders,
      });

      // Publish shard location to DHT
      const dhtRec = this.discovery.createSignedShardHoldersRecord(shardId, holders, secret);
      this.discovery.ingestRecord(dhtRec);
      const dhtEnv = this.p2p.createEnvelope('DHT_PUT', { record: dhtRec });
      this.p2p.sendEnvelope(dhtEnv);

      onProgress?.({ completed: i + 1, total: totalShards, phase: 'distributing' });
    }

    onProgress?.({ completed: totalShards, total: totalShards, phase: 'done' });

    return {
      fileId: sha256Hex(`${secret.did}:${file.name}:${Date.now()}:${bytesToHex(randomBytes(6))}`),
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      originalSize: file.bytes.length,
      encryptedSize: ciphertext.length,
      fileKeyHex: bytesToHex(fileKey),
      fileIvHex: ivHex,
      dataShards,
      parityShards,
      shardSize: rs.shardSize,
      shards: descriptors,
      createdAt: Date.now(),
    };
  }

  async downloadFile(
    manifest: FileManifest,
    onProgress?: (p: ShardTransferProgress) => void
  ): Promise<{ bytes: Uint8Array; blobUrl: string }> {
    const needed = manifest.dataShards;
    const collected: Array<{ index: number; bytes: Uint8Array }> = [];

    onProgress?.({ completed: 0, total: needed, phase: 'fetching' });

    // Query all shards in parallel batches, collecting up to `needed` valid shards
    await Promise.all(
      manifest.shards.map(async (shard) => {
        if (collected.length >= needed) return;

        // Gather known holders + DHT holders
        const dhtRec = this.discovery.getRecord(shardToDhtKey(shard.shardId));
        const dhtHolders =
          dhtRec && dhtRec.kind === 'shard_holders'
            ? ((dhtRec.value as { holders?: string[] }).holders ?? [])
            : [];
        const candidateHolders = Array.from(new Set([...shard.holders, ...dhtHolders]));

        for (const holderPeerId of candidateHolders) {
          if (collected.length >= needed) return;
          const bytes = await this.requestShardFromPeer(holderPeerId, shard.shardId);
          if (bytes && this.security.verifyShardIntegrity(shard.shardId, bytes)) {
            if (!collected.some((c) => c.index === shard.index)) {
              collected.push({ index: shard.index, bytes });
              onProgress?.({
                completed: Math.min(collected.length, needed),
                total: needed,
                phase: 'fetching',
              });
            }
            return;
          }
        }
      })
    );

    if (collected.length < needed) {
      throw new Error(
        `Недостаточно доступных фрагментов в сети: получено ${collected.length} из ${needed} необходимых`
      );
    }

    onProgress?.({ completed: needed, total: needed, phase: 'recovering' });
    const ciphertext = decodeReedSolomon(
      collected,
      manifest.dataShards,
      manifest.encryptedSize
    );

    onProgress?.({ completed: needed, total: needed, phase: 'decrypting' });
    const decrypted = await aesGcmDecrypt(
      hexToBytes(manifest.fileKeyHex),
      manifest.fileIvHex,
      ciphertext
    );

    const blob = new Blob([new Uint8Array(decrypted)], { type: manifest.mimeType });
    const blobUrl = URL.createObjectURL(blob);

    onProgress?.({ completed: needed, total: needed, phase: 'done' });
    return { bytes: decrypted, blobUrl };
  }
}
