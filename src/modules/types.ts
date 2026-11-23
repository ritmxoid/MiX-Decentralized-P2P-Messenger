/**
 * Shared TypeScript contracts and protocol definitions for the MiX modular P2P system.
 */

export type ScreenId =
  | 'contacts'
  | 'chats'
  | 'groups'
  | 'storage'
  | 'node'
  | 'network'
  | 'privacy'
  | 'security'
  | 'backups';

export interface IdentityPublicCard {
  did: string; // e.g. mix:a1b2c3...
  login: string; // unique handle without PII
  ed25519PublicKey: string; // hex (32 bytes)
  x25519PublicKey: string; // hex (32 bytes)
  peerId: string; // transport peer identifier
  createdAt: number;
  updatedAt: number;
  powNonce: number; // anti-Sybil Hashcash PoW nonce
  powDifficulty: number;
  signature: string; // Ed25519 signature over canonical card payload
}

export interface LocalIdentitySecret {
  did: string;
  login: string;
  ed25519PrivateKey: string; // hex (32 bytes)
  ed25519PublicKey: string;
  x25519PrivateKey: string; // hex (32 bytes)
  x25519PublicKey: string;
  createdAt: number;
  powNonce: number;
  powDifficulty: number;
}

export interface EncryptedKeystoreRecord {
  version: 1;
  login: string;
  did: string;
  saltHex: string;
  argon2Params: { t: number; m: number; p: number };
  ivHex: string;
  ciphertextHex: string; // AES-256-GCM encrypted LocalIdentitySecret + masterStorageKey
  publicCard: IdentityPublicCard;
}

export interface BackupFilePayload {
  format: 'mix-identity-backup-v1';
  exportedAt: number;
  keystore: EncryptedKeystoreRecord;
}

export interface PeerCapabilities {
  freeStorageBytes: number;
  maxStorageBytes: number;
  usedStorageBytes: number;
  alwaysOnNode: boolean;
  batteryLevel: number | null; // 0..1 or null if desktop/unknown
  charging: boolean | null;
  bandwidthBudgetMbps: number;
  regionHint?: string;
}

export interface PeerInfo {
  peerId: string;
  did?: string;
  login?: string;
  ed25519PublicKey?: string;
  x25519PublicKey?: string;
  transport: 'broadcast' | 'webrtc' | 'relay';
  connected: boolean;
  rttMs: number | null;
  connectedAt: number;
  lastSeen: number;
  reputation: number; // 0..100
  capabilities: PeerCapabilities;
  bytesSent: number;
  bytesReceived: number;
}

export interface DHTRecord {
  key: string; // SHA-256 hex of "@login" or "shard:<id>"
  kind: 'identity' | 'shard_holders' | 'offline_box';
  value: unknown;
  publisherDid: string;
  timestamp: number;
  ttlMs: number;
  signature: string;
}

export interface ContactEntry {
  did: string;
  login: string;
  ed25519PublicKey: string;
  x25519PublicKey: string;
  peerId?: string;
  verified: boolean;
  status: 'accepted' | 'pending_outgoing' | 'pending_incoming' | 'blocked';
  addedAt: number;
  lastSeen?: number;
}

export interface FileShardDescriptor {
  index: number;
  shardId: string; // SHA-256 of encrypted shard bytes
  sizeBytes: number;
  holders: string[]; // PeerIDs currently holding this shard
}

export interface FileManifest {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalSize: number;
  encryptedSize: number;
  fileKeyHex: string; // 256-bit AES key (transmitted ONLY inside E2EE chat envelope)
  fileIvHex: string;
  dataShards: number; // k
  parityShards: number; // m
  shardSize: number;
  shards: FileShardDescriptor[];
  createdAt: number;
}

export type MessageKind = 'text' | 'voice' | 'image' | 'video' | 'document' | 'archive' | 'file';

export type DeliveryStatus = 'sending' | 'stored_offline' | 'delivered' | 'read';

export interface ChatMessage {
  id: string;
  conversationId: string; // contact DID for 1:1, or groupId for group
  isGroup: boolean;
  senderDid: string;
  senderLogin: string;
  recipientDid?: string; // for 1:1
  seq: number;
  kind: MessageKind;
  text: string;
  fileManifest?: FileManifest;
  voiceDurationSec?: number;
  createdAt: number;
  editedAt?: number;
  deleted?: boolean;
  ttlSeconds?: number;
  expiresAt?: number;
  status: DeliveryStatus;
  verifiedSignature: boolean;
}

export interface GroupChat {
  groupId: string;
  name: string;
  creatorDid: string;
  members: Array<{
    did: string;
    login: string;
    ed25519PublicKey: string;
    x25519PublicKey: string;
  }>;
  keyEpoch: number;
  groupKeyHex: string; // 32-byte symmetric group key rotated on member change
  createdAt: number;
  updatedAt: number;
}

export interface StoredForeignShard {
  shardId: string;
  ownerDidHint: string; // opaque hash of uploader, never plaintext identity
  dataBase64: string;
  sizeBytes: number;
  storedAt: number;
  expiresAt: number;
  accessCount: number;
}

export interface OfflineEnvelopeRecord {
  envelopeId: string;
  targetDidHash: string;
  payloadJson: string;
  storedAt: number;
  expiresAt: number;
}

export interface NodeSettings {
  // Storage & Resource contribution (Section 5)
  maxStorageBytes: number;
  maxTrafficMbPerDay: number;
  allowMobileData: boolean;
  backgroundStorageEnabled: boolean;
  alwaysOnStorageNode: boolean;
  maxUploadBandwidthMbps: number;
  storageNodeActive: boolean;

  // Network & P2P (Section 3, 4, 8)
  networkEnabled: boolean; // master kill switch
  enableBroadcastChannel: boolean;
  enableWebRTC: boolean;
  enableVoluntaryRelay: boolean;
  relayEndpoint: string;

  // Metadata & Privacy (Section 10)
  onionRoutingEnabled: boolean;
  onionHops: 1 | 2;
  fixedPacketPadding: boolean;
  timingJitterMs: number;
  shareGeoHint: boolean;

  // Security (Section 13)
  maxRequestsPerMinutePerPeer: number;
  requirePowForDiscovery: boolean;
  autoQuarantineCorruptPeers: boolean;

  // UI
  theme: 'light' | 'dark';
}

export interface WireEnvelope {
  id: string;
  type:
    | 'PEER_HELLO'
    | 'DHT_PUT'
    | 'DHT_FIND'
    | 'DHT_VALUE'
    | 'CONTACT_REQUEST'
    | 'CONTACT_ACCEPT'
    | 'DIRECT_MSG'
    | 'MSG_ACK'
    | 'MSG_READ'
    | 'MSG_EDIT'
    | 'MSG_DELETE'
    | 'MSG_STORE_OFFLINE'
    | 'MSG_FETCH_OFFLINE'
    | 'MSG_OFFLINE_BATCH'
    | 'MSG_PURGE_OFFLINE'
    | 'GROUP_KEY_DIST'
    | 'GROUP_MSG'
    | 'SHARD_PUT'
    | 'SHARD_PUT_ACK'
    | 'SHARD_GET'
    | 'SHARD_DATA'
    | 'SHARD_PROBE'
    | 'SHARD_PROBE_ACK'
    | 'ONION_HOP'
    | 'PING'
    | 'PONG';
  fromPeerId: string;
  fromDid?: string;
  targetPeerId?: string;
  targetDid?: string;
  timestamp: number;
  nonce: string;
  payload: unknown;
  signature?: string; // Ed25519 signature when authenticated
}

export interface SecurityEvent {
  id: string;
  timestamp: number;
  severity: 'info' | 'warning' | 'blocked';
  peerId?: string;
  reason: string;
}

export interface NodeTelemetrySnapshot {
  peerId: string;
  did: string;
  login: string;
  networkEnabled: boolean;
  storageNodeActive: boolean;
  relayConnected: boolean;
  peers: PeerInfo[];
  dhtRecordCount: number;
  allocatedStorageBytes: number;
  usedStorageBytes: number;
  foreignShardCount: number;
  offlineEnvelopeCount: number;
  totalBytesSent: number;
  totalBytesReceived: number;
  servedRequestsCount: number;
  batteryLevel: number | null;
  charging: boolean | null;
  replicationHealth: {
    trackedFiles: number;
    healthyShards: number;
    totalShards: number;
    lastAuditAt: number | null;
    repairedCount: number;
  };
  securityEvents: SecurityEvent[];
}
