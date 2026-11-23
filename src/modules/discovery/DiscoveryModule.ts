/**
 * Discovery Module (Kademlia-style XOR-Distance DHT)
 *
 * Resolves @login -> IdentityPublicCard and shardId -> HolderPeerIds
 * without any central user directory or database.
 *
 * Anti-Sybil & Anti-Poisoning:
 * - Every identity DHT record is verified via Ed25519 signature + Hashcash PoW.
 * - Routing distance uses 256-bit SHA-256 XOR metric.
 */

import { sha256Hex, signEd25519, verifyEd25519 } from '../crypto/CryptoModule';
import { normalizeLogin } from '../identity/IdentityModule';
import type { SecurityModule } from '../security/SecurityModule';
import type { DHTRecord, IdentityPublicCard, LocalIdentitySecret } from '../types';

export function loginToDhtKey(login: string): string {
  return sha256Hex(`mix:login:${normalizeLogin(login)}`);
}

export function shardToDhtKey(shardId: string): string {
  return sha256Hex(`mix:shard:${shardId}`);
}

export function xorDistance(hexA: string, hexB: string): bigint {
  return BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
}

export class DiscoveryModule {
  private records = new Map<string, DHTRecord>();
  private knownCardsByDid = new Map<string, IdentityPublicCard>();
  private pendingLookups = new Map<
    string,
    Array<(record: DHTRecord | null) => void>
  >();

  constructor(private security: SecurityModule) {}

  getRecordCount(): number {
    return this.records.size;
  }

  getAllKnownIdentities(): IdentityPublicCard[] {
    return Array.from(this.knownCardsByDid.values());
  }

  getIdentityByDid(did: string): IdentityPublicCard | undefined {
    return this.knownCardsByDid.get(did);
  }

  createSignedIdentityRecord(
    card: IdentityPublicCard,
    secret: LocalIdentitySecret
  ): DHTRecord {
    const key = loginToDhtKey(card.login);
    const timestamp = Date.now();
    const ttlMs = 24 * 60 * 60 * 1000;
    const canonical = JSON.stringify({
      key,
      kind: 'identity',
      value: card,
      publisherDid: secret.did,
      timestamp,
      ttlMs,
    });
    const signature = signEd25519(canonical, secret.ed25519PrivateKey);
    return {
      key,
      kind: 'identity',
      value: card,
      publisherDid: secret.did,
      timestamp,
      ttlMs,
      signature,
    };
  }

  createSignedShardHoldersRecord(
    shardId: string,
    holders: string[],
    secret: LocalIdentitySecret
  ): DHTRecord {
    const key = shardToDhtKey(shardId);
    const timestamp = Date.now();
    const ttlMs = 7 * 24 * 60 * 60 * 1000;
    const canonical = JSON.stringify({
      key,
      kind: 'shard_holders',
      value: { shardId, holders },
      publisherDid: secret.did,
      timestamp,
      ttlMs,
    });
    const signature = signEd25519(canonical, secret.ed25519PrivateKey);
    return {
      key,
      kind: 'shard_holders',
      value: { shardId, holders },
      publisherDid: secret.did,
      timestamp,
      ttlMs,
      signature,
    };
  }

  ingestRecord(record: DHTRecord, fromPeerId?: string): boolean {
    if (!record || !record.key || !record.signature) return false;
    if (record.timestamp + record.ttlMs < Date.now()) return false;

    if (record.kind === 'identity') {
      const card = record.value as IdentityPublicCard;
      if (!this.security.verifyIdentityAnnouncement(card)) {
        if (fromPeerId) {
          this.security.adjustReputation(
            fromPeerId,
            -25,
            'Отправлена поддельная или неподтверждённая запись идентичности в DHT'
          );
        }
        return false;
      }
      if (loginToDhtKey(card.login) !== record.key) return false;

      const canonical = JSON.stringify({
        key: record.key,
        kind: record.kind,
        value: record.value,
        publisherDid: record.publisherDid,
        timestamp: record.timestamp,
        ttlMs: record.ttlMs,
      });
      if (!verifyEd25519(record.signature, canonical, card.ed25519PublicKey)) {
        return false;
      }

      const existing = this.records.get(record.key);
      if (existing) {
        const existingCard = existing.value as IdentityPublicCard;
        // Prevent login hijacking by a different DID if existing record is fresh
        if (existingCard.did !== card.did && existing.timestamp + existing.ttlMs > Date.now()) {
          return false;
        }
        if (existing.timestamp > record.timestamp) {
          return false;
        }
      }

      this.records.set(record.key, record);
      this.knownCardsByDid.set(card.did, card);
    } else if (record.kind === 'shard_holders') {
      const existing = this.records.get(record.key);
      if (existing && existing.timestamp > record.timestamp) {
        return false;
      }
      this.records.set(record.key, record);
    }

    // Resolve any awaiting lookup callbacks
    const waiters = this.pendingLookups.get(record.key);
    if (waiters) {
      this.pendingLookups.delete(record.key);
      for (const resolve of waiters) {
        resolve(record);
      }
    }
    return true;
  }

  getRecord(key: string): DHTRecord | null {
    const rec = this.records.get(key);
    if (!rec) return null;
    if (rec.timestamp + rec.ttlMs < Date.now()) {
      this.records.delete(key);
      return null;
    }
    return rec;
  }

  /**
   * Returns closest peers sorted by Kademlia XOR distance to targetKey.
   */
  selectClosestPeers(targetKey: string, peerIds: string[], k = 3): string[] {
    const targetHash = targetKey.length === 64 ? targetKey : sha256Hex(targetKey);
    return [...peerIds]
      .sort((a, b) => {
        const distA = xorDistance(sha256Hex(a), targetHash);
        const distB = xorDistance(sha256Hex(b), targetHash);
        return distA < distB ? -1 : distA > distB ? 1 : 0;
      })
      .slice(0, k);
  }

  async lookupLogin(
    login: string,
    broadcastFind: (key: string) => void,
    timeoutMs = 1500
  ): Promise<IdentityPublicCard | null> {
    const key = loginToDhtKey(login);
    const local = this.getRecord(key);
    if (local && local.kind === 'identity') {
      // Also trigger background refresh
      broadcastFind(key);
      return local.value as IdentityPublicCard;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.pendingLookups.get(key) || [];
        this.pendingLookups.set(
          key,
          list.filter((fn) => fn !== onFound)
        );
        resolve(null);
      }, timeoutMs);

      const onFound = (record: DHTRecord | null) => {
        clearTimeout(timer);
        resolve(record && record.kind === 'identity' ? (record.value as IdentityPublicCard) : null);
      };

      const existing = this.pendingLookups.get(key) || [];
      existing.push(onFound);
      this.pendingLookups.set(key, existing);

      broadcastFind(key);
    });
  }

  getAllActiveRecords(): DHTRecord[] {
    const now = Date.now();
    const active: DHTRecord[] = [];
    for (const [k, rec] of this.records.entries()) {
      if (rec.timestamp + rec.ttlMs < now) {
        this.records.delete(k);
      } else {
        active.push(rec);
      }
    }
    return active;
  }
}
