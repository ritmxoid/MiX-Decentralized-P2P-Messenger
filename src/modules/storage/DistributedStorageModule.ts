/**
 * Distributed Storage Module
 *
 * Manages local persistent IndexedDB storage for:
 * 1. Encrypted user keystore & E2EE private state (contacts, chats, groups, manifests)
 * 2. Foreign encrypted file shards contributed by the user's storage quota
 * 3. Temporary encrypted offline message envelopes (Store-and-Forward)
 *
 * Strictly enforces the user's configured storage limit (maxStorageBytes) and
 * ensures the node owner cannot read foreign encrypted shards.
 */

import {
  base64ToBytes,
  bytesToBase64,
  decryptJsonWithKey,
  encryptJsonWithKey,
  sha256Hex,
} from '../crypto/CryptoModule';
import type {
  ChatMessage,
  ContactEntry,
  EncryptedKeystoreRecord,
  FileManifest,
  GroupChat,
  NodeSettings,
  OfflineEnvelopeRecord,
  StoredForeignShard,
} from '../types';

export interface VaultPrivateState {
  contacts: ContactEntry[];
  messages: ChatMessage[];
  groups: GroupChat[];
  trackedManifests: FileManifest[];
  seqCounters: Record<string, number>;
}

export const DEFAULT_NODE_SETTINGS: NodeSettings = {
  maxStorageBytes: 512 * 1024 * 1024, // 512 MB default quota
  maxTrafficMbPerDay: 2048,
  allowMobileData: false,
  backgroundStorageEnabled: true,
  alwaysOnStorageNode: false,
  maxUploadBandwidthMbps: 25,
  storageNodeActive: true,

  networkEnabled: true,
  enableBroadcastChannel: true,
  enableWebRTC: true,
  enableVoluntaryRelay: true,
  relayEndpoint: '',

  onionRoutingEnabled: true,
  onionHops: 2,
  fixedPacketPadding: true,
  timingJitterMs: 120,
  shareGeoHint: false,

  maxRequestsPerMinutePerPeer: 240,
  requirePowForDiscovery: true,
  autoQuarantineCorruptPeers: true,

  theme: 'light',
};

const STORE_KEYSTORE = 'keystore';
const STORE_PRIVATE_STATE = 'private_state';
const STORE_SETTINGS = 'settings';
const STORE_FOREIGN_SHARDS = 'foreign_shards';
const STORE_OFFLINE_BOXES = 'offline_boxes';

export class DistributedStorageModule {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private dbName: string;
  private servedRequestsCount = 0;

  constructor(slotId = 'primary') {
    const safeSlot = slotId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'primary';
    this.dbName = `mix-vault-${safeSlot}`;
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_KEYSTORE)) {
          db.createObjectStore(STORE_KEYSTORE);
        }
        if (!db.objectStoreNames.contains(STORE_PRIVATE_STATE)) {
          db.createObjectStore(STORE_PRIVATE_STATE);
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS);
        }
        if (!db.objectStoreNames.contains(STORE_FOREIGN_SHARDS)) {
          db.createObjectStore(STORE_FOREIGN_SHARDS, { keyPath: 'shardId' });
        }
        if (!db.objectStoreNames.contains(STORE_OFFLINE_BOXES)) {
          db.createObjectStore(STORE_OFFLINE_BOXES, { keyPath: 'envelopeId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async txGet<T>(storeName: string, key: string): Promise<T | undefined> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  private async txPut(storeName: string, value: unknown, key?: string): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      if (key !== undefined) {
        store.put(value, key);
      } else {
        store.put(value);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async txDelete(storeName: string, key: string): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async txGetAll<T>(storeName: string): Promise<T[]> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve((req.result as T[]) || []);
      req.onerror = () => reject(req.error);
    });
  }

  async saveKeystore(record: EncryptedKeystoreRecord): Promise<void> {
    await this.txPut(STORE_KEYSTORE, record, 'active');
  }

  async loadKeystore(): Promise<EncryptedKeystoreRecord | null> {
    const rec = await this.txGet<EncryptedKeystoreRecord>(STORE_KEYSTORE, 'active');
    return rec ?? null;
  }

  async saveSettings(settings: NodeSettings): Promise<void> {
    await this.txPut(STORE_SETTINGS, settings, 'node');
  }

  async loadSettings(): Promise<NodeSettings> {
    const saved = await this.txGet<NodeSettings>(STORE_SETTINGS, 'node');
    return saved ? { ...DEFAULT_NODE_SETTINGS, ...saved } : { ...DEFAULT_NODE_SETTINGS };
  }

  async savePrivateState(state: VaultPrivateState, localVaultKey: Uint8Array): Promise<void> {
    const encrypted = await encryptJsonWithKey(localVaultKey, state, 'mix-private-state-v1');
    await this.txPut(STORE_PRIVATE_STATE, encrypted, 'state');
  }

  async loadPrivateState(localVaultKey: Uint8Array): Promise<VaultPrivateState> {
    const encrypted = await this.txGet<{ ivHex: string; ciphertextHex: string }>(
      STORE_PRIVATE_STATE,
      'state'
    );
    if (!encrypted) {
      return {
        contacts: [],
        messages: [],
        groups: [],
        trackedManifests: [],
        seqCounters: {},
      };
    }
    return decryptJsonWithKey<VaultPrivateState>(
      localVaultKey,
      encrypted.ivHex,
      encrypted.ciphertextHex,
      'mix-private-state-v1'
    );
  }

  // ============================================================================
  // Foreign Encrypted Shard Storage (Distributed Network Pool)
  // ============================================================================

  async getStorageStats(): Promise<{
    usedBytes: number;
    shardCount: number;
    offlineCount: number;
    servedRequestsCount: number;
  }> {
    const shards = await this.txGetAll<StoredForeignShard>(STORE_FOREIGN_SHARDS);
    const offline = await this.txGetAll<OfflineEnvelopeRecord>(STORE_OFFLINE_BOXES);
    const shardBytes = shards.reduce((acc, s) => acc + s.sizeBytes, 0);
    const offlineBytes = offline.reduce((acc, o) => acc + o.payloadJson.length, 0);
    return {
      usedBytes: shardBytes + offlineBytes,
      shardCount: shards.length,
      offlineCount: offline.length,
      servedRequestsCount: this.servedRequestsCount,
    };
  }

  async listForeignShards(): Promise<StoredForeignShard[]> {
    return this.txGetAll<StoredForeignShard>(STORE_FOREIGN_SHARDS);
  }

  async putForeignShard(
    shardId: string,
    bytes: Uint8Array,
    ownerDidHint: string,
    settings: NodeSettings,
    ttlMs = 30 * 24 * 60 * 60 * 1000
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (!settings.storageNodeActive || !settings.networkEnabled) {
      return { accepted: false, reason: 'storage_node_paused' };
    }
    const computedHash = sha256Hex(bytes);
    if (computedHash !== shardId) {
      return { accepted: false, reason: 'hash_mismatch' };
    }

    const existing = await this.txGet<StoredForeignShard>(STORE_FOREIGN_SHARDS, shardId);
    if (existing) {
      return { accepted: true };
    }

    const stats = await this.getStorageStats();
    if (stats.usedBytes + bytes.length > settings.maxStorageBytes) {
      return { accepted: false, reason: 'quota_exceeded' };
    }

    const record: StoredForeignShard = {
      shardId,
      ownerDidHint,
      dataBase64: bytesToBase64(bytes),
      sizeBytes: bytes.length,
      storedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      accessCount: 0,
    };
    await this.txPut(STORE_FOREIGN_SHARDS, record);
    return { accepted: true };
  }

  async getForeignShard(shardId: string): Promise<Uint8Array | null> {
    const rec = await this.txGet<StoredForeignShard>(STORE_FOREIGN_SHARDS, shardId);
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) {
      await this.txDelete(STORE_FOREIGN_SHARDS, shardId);
      return null;
    }
    this.servedRequestsCount++;
    rec.accessCount += 1;
    await this.txPut(STORE_FOREIGN_SHARDS, rec);
    return base64ToBytes(rec.dataBase64);
  }

  async hasForeignShard(shardId: string): Promise<boolean> {
    const rec = await this.txGet<StoredForeignShard>(STORE_FOREIGN_SHARDS, shardId);
    return !!rec && rec.expiresAt >= Date.now();
  }

  async removeForeignShard(shardId: string): Promise<void> {
    await this.txDelete(STORE_FOREIGN_SHARDS, shardId);
  }

  async purgeExpiredShards(): Promise<number> {
    const all = await this.txGetAll<StoredForeignShard>(STORE_FOREIGN_SHARDS);
    const now = Date.now();
    let purged = 0;
    for (const s of all) {
      if (s.expiresAt < now) {
        await this.txDelete(STORE_FOREIGN_SHARDS, s.shardId);
        purged++;
      }
    }
    return purged;
  }

  // ============================================================================
  // Temporary Encrypted Offline Message Store-and-Forward
  // ============================================================================

  async storeOfflineEnvelope(
    envelopeId: string,
    targetDidHash: string,
    payloadJson: string,
    settings: NodeSettings,
    ttlMs = 7 * 24 * 60 * 60 * 1000
  ): Promise<boolean> {
    if (!settings.storageNodeActive || !settings.networkEnabled) return false;
    const stats = await this.getStorageStats();
    if (stats.usedBytes + payloadJson.length > settings.maxStorageBytes) return false;

    const record: OfflineEnvelopeRecord = {
      envelopeId,
      targetDidHash,
      payloadJson,
      storedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    await this.txPut(STORE_OFFLINE_BOXES, record);
    return true;
  }

  async fetchOfflineEnvelopes(targetDidHash: string): Promise<OfflineEnvelopeRecord[]> {
    const all = await this.txGetAll<OfflineEnvelopeRecord>(STORE_OFFLINE_BOXES);
    const now = Date.now();
    return all.filter((rec) => rec.targetDidHash === targetDidHash && rec.expiresAt >= now);
  }

  async purgeOfflineEnvelope(envelopeId: string): Promise<void> {
    await this.txDelete(STORE_OFFLINE_BOXES, envelopeId);
  }
}
