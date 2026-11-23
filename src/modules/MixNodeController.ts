/**
 * MiX Node Controller
 *
 * Orchestrates all independent modules without central servers:
 * Identity, Auth, Cryptography, P2P Network, Discovery (DHT), Messaging,
 * Distributed Storage, File Transfer, Replication, Metadata Protection, and Security.
 */

import { AuthModule, type DecryptedVaultSession } from './auth/AuthModule';
import { bytesToBase64, bytesToHex, randomBytes, sha256Hex } from './crypto/CryptoModule';
import { DiscoveryModule } from './discovery/DiscoveryModule';
import {
  FileTransferModule,
  type ShardTransferProgress,
} from './fileTransfer/FileTransferModule';
import { IdentityModule } from './identity/IdentityModule';
import { MetadataModule, type OnionLayerPayload } from './metadata/MetadataModule';
import { MessagingModule, type PlainDirectMessageContent } from './messaging/MessagingModule';
import { P2PNetworkModule } from './p2p/P2PNetworkModule';
import { ReplicationModule } from './replication/ReplicationModule';
import { SecurityModule } from './security/SecurityModule';
import {
  DEFAULT_NODE_SETTINGS,
  DistributedStorageModule,
  type VaultPrivateState,
} from './storage/DistributedStorageModule';
import type {
  ChatMessage,
  ContactEntry,
  DHTRecord,
  EncryptedKeystoreRecord,
  FileManifest,
  GroupChat,
  IdentityPublicCard,
  MessageKind,
  NodeSettings,
  NodeTelemetrySnapshot,
  StoredForeignShard,
  WireEnvelope,
} from './types';

export type NodeUiListener = () => void;

export class MixNodeController {
  public readonly slotId: string;
  public readonly peerId: string;

  public readonly identity = new IdentityModule();
  public readonly auth = new AuthModule();
  public readonly storage: DistributedStorageModule;
  public readonly security: SecurityModule;
  public readonly discovery: DiscoveryModule;
  public readonly metadata = new MetadataModule();
  public readonly p2p: P2PNetworkModule;
  public readonly replication: ReplicationModule;
  public readonly fileTransfer: FileTransferModule;
  public readonly messaging: MessagingModule;

  private settings: NodeSettings = { ...DEFAULT_NODE_SETTINGS };
  private keystoreRecord: EncryptedKeystoreRecord | null = null;
  private session: DecryptedVaultSession | null = null;
  private privateState: VaultPrivateState = {
    contacts: [],
    messages: [],
    groups: [],
    trackedManifests: [],
    seqCounters: {},
  };

  private listeners = new Set<NodeUiListener>();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(slotId = 'primary') {
    this.slotId = slotId;
    this.peerId = `peer-${slotId}-${bytesToHex(randomBytes(6))}`;

    this.storage = new DistributedStorageModule(slotId);
    this.security = new SecurityModule(() => this.settings);
    this.discovery = new DiscoveryModule(this.security);
    this.p2p = new P2PNetworkModule(
      this.peerId,
      this.security,
      () => this.settings,
      () => this.storage.getStorageStats()
    );
    this.replication = new ReplicationModule(this.p2p, this.storage);
    this.fileTransfer = new FileTransferModule(
      this.p2p,
      this.storage,
      this.replication,
      this.discovery,
      this.security
    );
    this.messaging = new MessagingModule(
      this.p2p,
      this.metadata,
      this.storage,
      this.discovery,
      this.security
    );

    this.p2p.onEnvelope((env, viaPeerId) => {
      this.handleEnvelope(env, viaPeerId).catch(() => {});
    });
    this.p2p.onPeersChanged(() => {
      this.syncContactOnlineStates();
      this.emit();
    });
  }

  subscribe(listener: NodeUiListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.settings = await this.storage.loadSettings();
    this.keystoreRecord = await this.storage.loadKeystore();
    this.applyTheme(this.settings.theme);
    this.initialized = true;
    this.emit();
  }

  private applyTheme(theme: 'light' | 'dark'): void {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }
  }

  hasExistingAccount(): boolean {
    return this.keystoreRecord !== null;
  }

  getExistingLogin(): string | null {
    return this.keystoreRecord?.login ?? null;
  }

  isUnlocked(): boolean {
    return this.session !== null;
  }

  getSession(): DecryptedVaultSession | null {
    return this.session;
  }

  getSettings(): NodeSettings {
    return this.settings;
  }

  getContacts(): ContactEntry[] {
    return this.privateState.contacts;
  }

  getMessages(conversationId: string): ChatMessage[] {
    return this.privateState.messages
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getAllMessages(): ChatMessage[] {
    return this.privateState.messages;
  }

  getGroups(): GroupChat[] {
    return this.privateState.groups;
  }

  getTrackedManifests(): FileManifest[] {
    return this.privateState.trackedManifests;
  }

  // ============================================================================
  // Account Lifecycle (No Server / Zero PII)
  // ============================================================================

  async createAccount(
    login: string,
    password: string,
    initialSettings?: Partial<NodeSettings>
  ): Promise<void> {
    if (initialSettings) {
      this.settings = { ...this.settings, ...initialSettings };
      await this.storage.saveSettings(this.settings);
      this.applyTheme(this.settings.theme);
    }

    const { secret, publicCard } = this.identity.createIdentity(login, this.peerId);
    const { keystore, localVaultKey } = await this.auth.sealKeystore(
      secret,
      publicCard,
      password
    );

    await this.storage.saveKeystore(keystore);
    this.keystoreRecord = keystore;
    this.session = { secret, publicCard, localVaultKey };
    this.privateState = {
      contacts: [],
      messages: [],
      groups: [],
      trackedManifests: [],
      seqCounters: {},
    };
    await this.persistPrivateState();

    await this.startSessionServices();
    this.security.recordEvent('info', `Создана анонимная криптографическая идентичность @${secret.login}`);
    this.emit();
  }

  async unlockAccount(password: string): Promise<void> {
    if (!this.keystoreRecord) {
      throw new Error('Локальный аккаунт не найден. Создайте новый или импортируйте копию.');
    }
    const unlocked = await this.auth.unlockKeystore(this.keystoreRecord, password);
    // Refresh public card with current session peerId
    const freshCard = this.identity.signPublicCard(unlocked.secret, this.peerId);
    unlocked.publicCard = freshCard;

    this.session = unlocked;
    this.privateState = await this.storage.loadPrivateState(unlocked.localVaultKey);
    this.security.setBlockedDids(
      this.privateState.contacts.filter((c) => c.status === 'blocked').map((c) => c.did)
    );

    await this.startSessionServices();
    this.security.recordEvent('info', `Локальное хранилище ключей разблокировано для @${unlocked.secret.login}`);
    this.emit();
  }

  async importBackupAndUnlock(rawJson: string, password: string): Promise<void> {
    const importedKeystore = this.identity.parseBackup(rawJson);
    const unlocked = await this.auth.unlockKeystore(importedKeystore, password);
    const freshCard = this.identity.signPublicCard(unlocked.secret, this.peerId);
    const { keystore } = await this.auth.sealKeystore(unlocked.secret, freshCard, password);

    await this.storage.saveKeystore(keystore);
    this.keystoreRecord = keystore;
    unlocked.publicCard = freshCard;
    this.session = unlocked;
    this.privateState = await this.storage.loadPrivateState(unlocked.localVaultKey);

    await this.startSessionServices();
    this.security.recordEvent('info', `Восстановлена идентичность @${unlocked.secret.login} из резервной копии`);
    this.emit();
  }

  exportBackupJson(): string {
    if (!this.keystoreRecord) {
      throw new Error('Нет активного аккаунта для экспорта');
    }
    return this.identity.exportBackup(this.keystoreRecord);
  }

  lockAccount(): void {
    this.stopMaintenance();
    this.p2p.stop();
    this.session = null;
    this.privateState = {
      contacts: [],
      messages: [],
      groups: [],
      trackedManifests: [],
      seqCounters: {},
    };
    this.emit();
  }

  private async startSessionServices(): Promise<void> {
    if (!this.session) return;
    await this.p2p.start(this.session.secret, this.session.publicCard);
    this.publishIdentityToDht();
    this.messaging.fetchOfflineInboxFromPeers(this.session.secret.did);
    this.startMaintenance();
  }

  private startMaintenance(): void {
    this.stopMaintenance();
    this.maintenanceTimer = setInterval(() => {
      this.runMaintenanceCycle().catch(() => {});
    }, 8000);
  }

  private stopMaintenance(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
  }

  private async runMaintenanceCycle(): Promise<void> {
    if (!this.session) return;

    // 1. Disappearing message TTL cleanup
    const ttlRes = this.messaging.filterExpiredMessages(this.privateState.messages);
    if (ttlRes.changed) {
      this.privateState.messages = ttlRes.kept;
      await this.persistPrivateState();
      this.emit();
    }

    // 2. Purge expired foreign shards
    await this.storage.purgeExpiredShards();

    // 3. Republish DHT card if network active
    if (this.settings.networkEnabled) {
      this.publishIdentityToDht();
      this.messaging.fetchOfflineInboxFromPeers(this.session.secret.did);
    }
  }

  private publishIdentityToDht(): void {
    if (!this.session || !this.settings.networkEnabled) return;
    const record = this.discovery.createSignedIdentityRecord(
      this.session.publicCard,
      this.session.secret
    );
    this.discovery.ingestRecord(record);
    const env = this.p2p.createEnvelope('DHT_PUT', { record });
    this.p2p.sendEnvelope(env);
  }

  private async persistPrivateState(): Promise<void> {
    if (!this.session) return;
    await this.storage.savePrivateState(this.privateState, this.session.localVaultKey);
  }

  async updateSettings(patch: Partial<NodeSettings>): Promise<void> {
    const prev = this.settings;
    this.settings = { ...this.settings, ...patch };
    await this.storage.saveSettings(this.settings);
    this.applyTheme(this.settings.theme);

    if (prev.networkEnabled !== this.settings.networkEnabled) {
      if (this.settings.networkEnabled && this.session) {
        await this.p2p.start(this.session.secret, this.session.publicCard);
        this.publishIdentityToDht();
      } else {
        this.p2p.stop();
      }
    } else if (
      prev.enableBroadcastChannel !== this.settings.enableBroadcastChannel ||
      prev.enableWebRTC !== this.settings.enableWebRTC ||
      prev.enableVoluntaryRelay !== this.settings.enableVoluntaryRelay ||
      prev.relayEndpoint !== this.settings.relayEndpoint
    ) {
      await this.p2p.restart();
    } else if (this.settings.networkEnabled && this.session) {
      await this.p2p.announceSelf();
    }

    this.emit();
  }

  // ============================================================================
  // Discovery & Contacts
  // ============================================================================

  async searchUserByLogin(login: string): Promise<IdentityPublicCard | null> {
    const card = await this.discovery.lookupLogin(login, (key) => {
      const env = this.p2p.createEnvelope('DHT_FIND', { key });
      this.p2p.sendEnvelope(env);
    });
    return card;
  }

  getDiscoveredNetworkIdentities(): IdentityPublicCard[] {
    if (!this.session) return [];
    const byDid = new Map<string, IdentityPublicCard>();
    for (const c of this.discovery.getAllKnownIdentities()) {
      if (c.did !== this.session.secret.did) byDid.set(c.did, c);
    }
    for (const p of this.p2p.getConnectedPeers()) {
      if (p.did && p.login && p.ed25519PublicKey && p.x25519PublicKey && p.did !== this.session.secret.did) {
        if (!byDid.has(p.did)) {
          byDid.set(p.did, {
            did: p.did,
            login: p.login,
            ed25519PublicKey: p.ed25519PublicKey,
            x25519PublicKey: p.x25519PublicKey,
            peerId: p.peerId,
            createdAt: p.connectedAt,
            updatedAt: p.lastSeen,
            powNonce: 0,
            powDifficulty: 0,
            signature: '',
          });
        }
      }
    }
    return Array.from(byDid.values());
  }

  async sendContactRequest(targetCard: IdentityPublicCard): Promise<void> {
    if (!this.session) return;
    if (targetCard.did === this.session.secret.did) return;

    const existing = this.privateState.contacts.find((c) => c.did === targetCard.did);
    if (!existing) {
      this.privateState.contacts.push({
        did: targetCard.did,
        login: targetCard.login,
        ed25519PublicKey: targetCard.ed25519PublicKey,
        x25519PublicKey: targetCard.x25519PublicKey,
        peerId: targetCard.peerId,
        verified: true,
        status: 'pending_outgoing',
        addedAt: Date.now(),
      });
      await this.persistPrivateState();
    }

    const env = this.p2p.createEnvelope(
      'CONTACT_REQUEST',
      { card: this.session.publicCard },
      targetCard.peerId,
      targetCard.did
    );

    const livePeer = this.p2p.getPeerByDid(targetCard.did);
    if (livePeer) {
      this.p2p.sendEnvelope(env, livePeer.peerId);
    } else if (targetCard.peerId && this.p2p.getPeer(targetCard.peerId)?.connected) {
      this.p2p.sendEnvelope(env, targetCard.peerId);
    } else {
      await this.messaging.storeOfflineForRecipient(targetCard.did, env);
    }
    this.emit();
  }

  async acceptContactRequest(did: string): Promise<void> {
    if (!this.session) return;
    const contact = this.privateState.contacts.find((c) => c.did === did);
    if (!contact) return;

    contact.status = 'accepted';
    await this.persistPrivateState();

    const env = this.p2p.createEnvelope(
      'CONTACT_ACCEPT',
      { card: this.session.publicCard },
      contact.peerId,
      contact.did
    );

    const livePeer = this.p2p.getPeerByDid(contact.did);
    if (livePeer) {
      this.p2p.sendEnvelope(env, livePeer.peerId);
    } else {
      await this.messaging.storeOfflineForRecipient(contact.did, env);
    }
    this.emit();
  }

  async blockContact(did: string): Promise<void> {
    const contact = this.privateState.contacts.find((c) => c.did === did);
    if (contact) {
      contact.status = 'blocked';
      this.security.setBlockedDids(
        this.privateState.contacts.filter((c) => c.status === 'blocked').map((c) => c.did)
      );
      if (contact.peerId) {
        this.security.blockPeer(contact.peerId, `Контакт @${contact.login} заблокирован пользователем`);
      }
      await this.persistPrivateState();
      this.emit();
    }
  }

  async unblockContact(did: string): Promise<void> {
    const contact = this.privateState.contacts.find((c) => c.did === did);
    if (contact) {
      contact.status = 'accepted';
      this.security.setBlockedDids(
        this.privateState.contacts.filter((c) => c.status === 'blocked').map((c) => c.did)
      );
      if (contact.peerId) {
        this.security.unblockPeer(contact.peerId);
      }
      await this.persistPrivateState();
      this.emit();
    }
  }

  private syncContactOnlineStates(): void {
    for (const c of this.privateState.contacts) {
      const peer = this.p2p.getPeerByDid(c.did);
      if (peer) {
        c.peerId = peer.peerId;
        c.lastSeen = peer.lastSeen;
      }
    }
  }

  // ============================================================================
  // Direct & Group Messaging + Distributed File Transfer
  // ============================================================================

  async sendDirectMessage(
    contactDid: string,
    text: string,
    options?: {
      kind?: MessageKind;
      fileManifest?: FileManifest;
      voiceDurationSec?: number;
      ttlSeconds?: number;
    }
  ): Promise<ChatMessage> {
    if (!this.session) throw new Error('Узел заблокирован');
    const contact = this.privateState.contacts.find((c) => c.did === contactDid);
    if (!contact) throw new Error('Контакт не найден');
    if (contact.status === 'blocked') throw new Error('Контакт заблокирован');

    const seq = (this.privateState.seqCounters[contactDid] ?? 0) + 1;
    this.privateState.seqCounters[contactDid] = seq;

    const now = Date.now();
    const messageId = `msg-${now}-${bytesToHex(randomBytes(6))}`;
    const ttlSeconds = options?.ttlSeconds;

    const content: PlainDirectMessageContent = {
      messageId,
      kind: options?.kind ?? 'text',
      text,
      fileManifest: options?.fileManifest,
      voiceDurationSec: options?.voiceDurationSec,
      ttlSeconds,
      createdAt: now,
      senderLogin: this.session.secret.login,
    };

    const msg: ChatMessage = {
      id: messageId,
      conversationId: contactDid,
      isGroup: false,
      senderDid: this.session.secret.did,
      senderLogin: this.session.secret.login,
      recipientDid: contactDid,
      seq,
      kind: content.kind,
      text,
      fileManifest: options?.fileManifest,
      voiceDurationSec: options?.voiceDurationSec,
      createdAt: now,
      ttlSeconds,
      expiresAt: ttlSeconds ? now + ttlSeconds * 1000 : undefined,
      status: 'sending',
      verifiedSignature: true,
    };

    this.privateState.messages.push(msg);
    if (options?.fileManifest) {
      this.privateState.trackedManifests.push(options.fileManifest);
    }
    await this.persistPrivateState();
    this.emit();

    const env = await this.messaging.buildDirectMessageEnvelope(
      this.session.secret,
      contact,
      seq,
      content
    );

    const livePeer = this.p2p.getPeerByDid(contactDid);
    if (livePeer && this.settings.networkEnabled) {
      const sent = await this.messaging.sendDirectEnvelopeWithPrivacy(
        livePeer.peerId,
        contact.x25519PublicKey,
        env,
        this.settings
      );
      if (!sent) {
        const stored = await this.messaging.storeOfflineForRecipient(contactDid, env);
        msg.status = stored ? 'stored_offline' : 'sending';
      }
    } else if (this.settings.networkEnabled) {
      const stored = await this.messaging.storeOfflineForRecipient(contactDid, env);
      msg.status = stored ? 'stored_offline' : 'sending';
    }

    await this.persistPrivateState();
    this.emit();
    return msg;
  }

  async sendFileToConversation(
    conversationId: string,
    isGroup: boolean,
    file: File,
    onProgress?: (p: ShardTransferProgress) => void,
    ttlSeconds?: number
  ): Promise<ChatMessage> {
    if (!this.session) throw new Error('Узел заблокирован');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const manifest = await this.fileTransfer.uploadFile(
      { name: file.name, type: file.type, bytes },
      this.session.secret,
      this.settings,
      onProgress
    );

    const kind: MessageKind = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
        ? 'video'
        : file.type.startsWith('audio/')
          ? 'voice'
          : /\.(zip|tar|gz|7z|rar)$/i.test(file.name)
            ? 'archive'
            : /\.(pdf|doc|docx|txt|md|csv|json)$/i.test(file.name)
              ? 'document'
              : 'file';

    if (isGroup) {
      return this.sendGroupMessage(conversationId, file.name, {
        kind,
        fileManifest: manifest,
        ttlSeconds,
      });
    }
    return this.sendDirectMessage(conversationId, file.name, {
      kind,
      fileManifest: manifest,
      ttlSeconds,
    });
  }

  async sendVoiceMessage(
    conversationId: string,
    isGroup: boolean,
    blob: Blob,
    durationSec: number,
    ttlSeconds?: number
  ): Promise<ChatMessage> {
    if (!this.session) throw new Error('Узел заблокирован');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const manifest = await this.fileTransfer.uploadFile(
      {
        name: `voice-${Date.now()}.webm`,
        type: blob.type || 'audio/webm',
        bytes,
      },
      this.session.secret,
      this.settings
    );

    if (isGroup) {
      return this.sendGroupMessage(conversationId, 'Голосовое сообщение', {
        kind: 'voice',
        fileManifest: manifest,
        voiceDurationSec: durationSec,
        ttlSeconds,
      });
    }
    return this.sendDirectMessage(conversationId, 'Голосовое сообщение', {
      kind: 'voice',
      fileManifest: manifest,
      voiceDurationSec: durationSec,
      ttlSeconds,
    });
  }

  async editMessage(messageId: string, newText: string): Promise<void> {
    if (!this.session) return;
    const msg = this.privateState.messages.find((m) => m.id === messageId);
    if (!msg || msg.senderDid !== this.session.secret.did || msg.deleted) return;

    msg.text = newText;
    msg.editedAt = Date.now();
    await this.persistPrivateState();

    if (!msg.isGroup && msg.recipientDid) {
      const livePeer = this.p2p.getPeerByDid(msg.recipientDid);
      const contact = this.privateState.contacts.find((c) => c.did === msg.recipientDid);
      if (livePeer && contact) {
        const env = this.p2p.createEnvelope(
          'MSG_EDIT',
          { messageId, newText, editedAt: msg.editedAt },
          livePeer.peerId,
          contact.did
        );
        await this.messaging.sendDirectEnvelopeWithPrivacy(
          livePeer.peerId,
          contact.x25519PublicKey,
          env,
          this.settings
        );
      }
    }
    this.emit();
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (!this.session) return;
    const msg = this.privateState.messages.find((m) => m.id === messageId);
    if (!msg) return;

    msg.deleted = true;
    msg.text = 'Сообщение удалено';
    msg.fileManifest = undefined;
    await this.persistPrivateState();

    if (!msg.isGroup && msg.recipientDid) {
      const livePeer = this.p2p.getPeerByDid(msg.recipientDid);
      const contact = this.privateState.contacts.find((c) => c.did === msg.recipientDid);
      if (livePeer && contact) {
        const env = this.p2p.createEnvelope(
          'MSG_DELETE',
          { messageId },
          livePeer.peerId,
          contact.did
        );
        await this.messaging.sendDirectEnvelopeWithPrivacy(
          livePeer.peerId,
          contact.x25519PublicKey,
          env,
          this.settings
        );
      }
    }
    this.emit();
  }

  async markConversationRead(conversationId: string): Promise<void> {
    if (!this.session) return;
    const unread = this.privateState.messages.filter(
      (m) =>
        m.conversationId === conversationId &&
        m.senderDid !== this.session!.secret.did &&
        m.status !== 'read'
    );
    if (unread.length === 0) return;

    for (const m of unread) {
      m.status = 'read';
      if (!m.isGroup) {
        const livePeer = this.p2p.getPeerByDid(m.senderDid);
        const contact = this.privateState.contacts.find((c) => c.did === m.senderDid);
        if (livePeer && contact) {
          const env = this.p2p.createEnvelope(
            'MSG_READ',
            { messageId: m.id },
            livePeer.peerId,
            contact.did
          );
          this.p2p.sendEnvelope(env, livePeer.peerId);
        }
      }
    }
    await this.persistPrivateState();
    this.emit();
  }

  // ============================================================================
  // Group Chats
  // ============================================================================

  async createGroup(name: string, memberDids: string[]): Promise<GroupChat> {
    if (!this.session) throw new Error('Узел заблокирован');
    const members = this.privateState.contacts.filter((c) => memberDids.includes(c.did));
    const group = this.messaging.createGroup(name, this.session.secret, members);
    this.privateState.groups.push(group);
    await this.persistPrivateState();
    await this.messaging.distributeGroupKey(group, this.session.secret, this.settings);
    this.emit();
    return group;
  }

  async addGroupMember(groupId: string, contactDid: string): Promise<void> {
    if (!this.session) return;
    const idx = this.privateState.groups.findIndex((g) => g.groupId === groupId);
    const contact = this.privateState.contacts.find((c) => c.did === contactDid);
    if (idx === -1 || !contact) return;

    let group = this.privateState.groups[idx];
    if (group.members.some((m) => m.did === contactDid)) return;

    group = this.messaging.rotateGroupKey({
      ...group,
      members: [
        ...group.members,
        {
          did: contact.did,
          login: contact.login,
          ed25519PublicKey: contact.ed25519PublicKey,
          x25519PublicKey: contact.x25519PublicKey,
        },
      ],
    });
    this.privateState.groups[idx] = group;
    await this.persistPrivateState();
    await this.messaging.distributeGroupKey(group, this.session.secret, this.settings);
    this.emit();
  }

  async removeGroupMember(groupId: string, memberDid: string): Promise<void> {
    if (!this.session) return;
    const idx = this.privateState.groups.findIndex((g) => g.groupId === groupId);
    if (idx === -1) return;

    let group = this.privateState.groups[idx];
    group = this.messaging.rotateGroupKey({
      ...group,
      members: group.members.filter((m) => m.did !== memberDid),
    });
    this.privateState.groups[idx] = group;
    await this.persistPrivateState();
    await this.messaging.distributeGroupKey(group, this.session.secret, this.settings);
    this.emit();
  }

  async sendGroupMessage(
    groupId: string,
    text: string,
    options?: {
      kind?: MessageKind;
      fileManifest?: FileManifest;
      voiceDurationSec?: number;
      ttlSeconds?: number;
    }
  ): Promise<ChatMessage> {
    if (!this.session) throw new Error('Узел заблокирован');
    const group = this.privateState.groups.find((g) => g.groupId === groupId);
    if (!group) throw new Error('Группа не найдена');

    const now = Date.now();
    const messageId = `gmsg-${now}-${bytesToHex(randomBytes(6))}`;
    const content: PlainDirectMessageContent = {
      messageId,
      kind: options?.kind ?? 'text',
      text,
      fileManifest: options?.fileManifest,
      voiceDurationSec: options?.voiceDurationSec,
      ttlSeconds: options?.ttlSeconds,
      createdAt: now,
      senderLogin: this.session.secret.login,
    };

    const msg: ChatMessage = {
      id: messageId,
      conversationId: groupId,
      isGroup: true,
      senderDid: this.session.secret.did,
      senderLogin: this.session.secret.login,
      seq: now,
      kind: content.kind,
      text,
      fileManifest: options?.fileManifest,
      voiceDurationSec: options?.voiceDurationSec,
      createdAt: now,
      ttlSeconds: options?.ttlSeconds,
      expiresAt: options?.ttlSeconds ? now + options.ttlSeconds * 1000 : undefined,
      status: 'delivered',
      verifiedSignature: true,
    };

    this.privateState.messages.push(msg);
    if (options?.fileManifest) {
      this.privateState.trackedManifests.push(options.fileManifest);
    }
    await this.persistPrivateState();
    this.emit();

    const env = await this.messaging.buildGroupMessageEnvelope(
      this.session.secret,
      group,
      content
    );

    for (const member of group.members) {
      if (member.did === this.session.secret.did) continue;
      const livePeer = this.p2p.getPeerByDid(member.did);
      if (livePeer && this.settings.networkEnabled) {
        await this.messaging.sendDirectEnvelopeWithPrivacy(
          livePeer.peerId,
          member.x25519PublicKey,
          env,
          this.settings
        );
      } else if (this.settings.networkEnabled) {
        await this.messaging.storeOfflineForRecipient(member.did, env);
      }
    }

    return msg;
  }

  // ============================================================================
  // Storage & Replication Controls
  // ============================================================================

  async auditAndRepairReplication(): Promise<{
    healthy: number;
    total: number;
    repaired: number;
  }> {
    if (!this.session) return { healthy: 0, total: 0, repaired: 0 };
    const myDidHash = sha256Hex(this.session.secret.did).slice(0, 16);
    const res = await this.replication.auditAndRepairManifests(
      this.privateState.trackedManifests,
      myDidHash,
      (updated) => {
        const idx = this.privateState.trackedManifests.findIndex(
          (m) => m.fileId === updated.fileId
        );
        if (idx !== -1) {
          this.privateState.trackedManifests[idx] = updated;
        }
      }
    );
    await this.persistPrivateState();
    this.emit();
    return res;
  }

  async listStoredForeignShards(): Promise<StoredForeignShard[]> {
    return this.storage.listForeignShards();
  }

  async deleteForeignShardLocally(shardId: string): Promise<void> {
    await this.storage.removeForeignShard(shardId);
    this.emit();
  }

  async getTelemetrySnapshot(): Promise<NodeTelemetrySnapshot> {
    const stats = await this.storage.getStorageStats();
    const traffic = this.p2p.getTrafficStats();
    const battery = this.p2p.getBatteryState();
    return {
      peerId: this.peerId,
      did: this.session?.secret.did ?? '',
      login: this.session?.secret.login ?? '',
      networkEnabled: this.settings.networkEnabled,
      storageNodeActive: this.settings.storageNodeActive,
      relayConnected: this.p2p.isRelayConnected(),
      peers: this.p2p.getAllKnownPeers(),
      dhtRecordCount: this.discovery.getRecordCount(),
      allocatedStorageBytes: this.settings.maxStorageBytes,
      usedStorageBytes: stats.usedBytes,
      foreignShardCount: stats.shardCount,
      offlineEnvelopeCount: stats.offlineCount,
      totalBytesSent: traffic.totalBytesSent,
      totalBytesReceived: traffic.totalBytesReceived,
      servedRequestsCount: stats.servedRequestsCount,
      batteryLevel: battery.batteryLevel,
      charging: battery.charging,
      replicationHealth: this.replication.getHealthSnapshot(
        this.privateState.trackedManifests.length
      ),
      securityEvents: this.security.getEvents(),
    };
  }

  // ============================================================================
  // Protocol Envelope Dispatcher
  // ============================================================================

  private async handleEnvelope(env: WireEnvelope, viaPeerId: string): Promise<void> {
    if (!this.session) return;

    switch (env.type) {
      case 'ONION_HOP': {
        try {
          const peeled = await this.metadata.peelOnionLayer(
            this.session.secret.x25519PrivateKey,
            env.payload as OnionLayerPayload
          );
          if (peeled.action === 'forward') {
            const forwardEnv = this.p2p.createEnvelope(
              'ONION_HOP',
              peeled.nextLayer,
              peeled.nextPeerId,
              undefined,
              false
            );
            this.p2p.sendEnvelope(forwardEnv, peeled.nextPeerId);
          } else {
            await this.handleEnvelope(peeled.envelope, viaPeerId);
          }
        } catch {
          // Not decryptable by this node or malformed onion layer
        }
        return;
      }

      case 'DHT_PUT': {
        const record = (env.payload as { record?: DHTRecord })?.record;
        if (record) {
          this.discovery.ingestRecord(record, env.fromPeerId);
          this.emit();
        }
        return;
      }

      case 'DHT_FIND': {
        const key = (env.payload as { key?: string })?.key;
        if (!key) return;
        const found = this.discovery.getRecord(key);
        if (found) {
          const reply = this.p2p.createEnvelope('DHT_VALUE', { record: found }, env.fromPeerId);
          this.p2p.sendEnvelope(reply, env.fromPeerId);
        }
        return;
      }

      case 'DHT_VALUE': {
        const record = (env.payload as { record?: DHTRecord })?.record;
        if (record) {
          this.discovery.ingestRecord(record, env.fromPeerId);
          this.emit();
        }
        return;
      }

      case 'CONTACT_REQUEST': {
        const card = (env.payload as { card?: IdentityPublicCard })?.card;
        if (!card || !this.security.verifyIdentityAnnouncement(card)) return;
        if (this.security.isPeerBlocked(env.fromPeerId, card.did)) return;

        const existing = this.privateState.contacts.find((c) => c.did === card.did);
        if (!existing) {
          this.privateState.contacts.push({
            did: card.did,
            login: card.login,
            ed25519PublicKey: card.ed25519PublicKey,
            x25519PublicKey: card.x25519PublicKey,
            peerId: card.peerId,
            verified: true,
            status: 'pending_incoming',
            addedAt: Date.now(),
          });
        } else if (existing.status === 'pending_outgoing') {
          existing.status = 'accepted';
        }
        await this.persistPrivateState();
        this.emit();
        return;
      }

      case 'CONTACT_ACCEPT': {
        const card = (env.payload as { card?: IdentityPublicCard })?.card;
        if (!card || !this.security.verifyIdentityAnnouncement(card)) return;
        const existing = this.privateState.contacts.find((c) => c.did === card.did);
        if (existing) {
          existing.status = 'accepted';
          existing.peerId = card.peerId;
        } else {
          this.privateState.contacts.push({
            did: card.did,
            login: card.login,
            ed25519PublicKey: card.ed25519PublicKey,
            x25519PublicKey: card.x25519PublicKey,
            peerId: card.peerId,
            verified: true,
            status: 'accepted',
            addedAt: Date.now(),
          });
        }
        await this.persistPrivateState();
        this.emit();
        return;
      }

      case 'DIRECT_MSG': {
        if (!env.fromDid) return;
        let contact = this.privateState.contacts.find((c) => c.did === env.fromDid);
        const peerCard = this.discovery.getIdentityByDid(env.fromDid);
        const senderEdPub = contact?.ed25519PublicKey ?? peerCard?.ed25519PublicKey;

        try {
          const { content, seq, verified } = await this.messaging.decryptDirectEnvelope(
            env,
            this.session.secret,
            senderEdPub
          );

          if (!contact && peerCard) {
            contact = {
              did: peerCard.did,
              login: peerCard.login,
              ed25519PublicKey: peerCard.ed25519PublicKey,
              x25519PublicKey: peerCard.x25519PublicKey,
              peerId: env.fromPeerId,
              verified: true,
              status: 'pending_incoming',
              addedAt: Date.now(),
            };
            this.privateState.contacts.push(contact);
          }

          if (this.privateState.messages.some((m) => m.id === content.messageId)) {
            return; // Idempotent duplicate guard
          }

          const msg: ChatMessage = {
            id: content.messageId,
            conversationId: env.fromDid,
            isGroup: false,
            senderDid: env.fromDid,
            senderLogin: content.senderLogin,
            recipientDid: this.session.secret.did,
            seq,
            kind: content.kind,
            text: content.text,
            fileManifest: content.fileManifest,
            voiceDurationSec: content.voiceDurationSec,
            createdAt: content.createdAt,
            ttlSeconds: content.ttlSeconds,
            expiresAt: content.ttlSeconds
              ? Date.now() + content.ttlSeconds * 1000
              : undefined,
            status: 'delivered',
            verifiedSignature: verified,
          };

          this.privateState.messages.push(msg);
          if (content.fileManifest) {
            this.privateState.trackedManifests.push(content.fileManifest);
          }
          await this.persistPrivateState();

          // Send delivery ACK back
          const ack = this.p2p.createEnvelope(
            'MSG_ACK',
            { messageId: content.messageId },
            env.fromPeerId,
            env.fromDid
          );
          this.p2p.sendEnvelope(ack, env.fromPeerId);
          this.emit();
        } catch {
          // Ignore undecryptable envelope
        }
        return;
      }

      case 'MSG_ACK': {
        const messageId = (env.payload as { messageId?: string })?.messageId;
        if (!messageId) return;
        const msg = this.privateState.messages.find((m) => m.id === messageId);
        if (msg && msg.status !== 'read') {
          msg.status = 'delivered';
          await this.persistPrivateState();
          this.emit();
        }
        return;
      }

      case 'MSG_READ': {
        const messageId = (env.payload as { messageId?: string })?.messageId;
        if (!messageId) return;
        const msg = this.privateState.messages.find((m) => m.id === messageId);
        if (msg) {
          msg.status = 'read';
          await this.persistPrivateState();
          this.emit();
        }
        return;
      }

      case 'MSG_EDIT': {
        const { messageId, newText, editedAt } = env.payload as {
          messageId: string;
          newText: string;
          editedAt: number;
        };
        const msg = this.privateState.messages.find((m) => m.id === messageId);
        if (msg && msg.senderDid === env.fromDid) {
          msg.text = newText;
          msg.editedAt = editedAt;
          await this.persistPrivateState();
          this.emit();
        }
        return;
      }

      case 'MSG_DELETE': {
        const { messageId } = env.payload as { messageId: string };
        const msg = this.privateState.messages.find((m) => m.id === messageId);
        if (msg && msg.senderDid === env.fromDid) {
          msg.deleted = true;
          msg.text = 'Сообщение удалено';
          msg.fileManifest = undefined;
          await this.persistPrivateState();
          this.emit();
        }
        return;
      }

      case 'MSG_STORE_OFFLINE': {
        const { envelopeId, targetDidHash, envelope } = env.payload as {
          envelopeId: string;
          targetDidHash: string;
          envelope: WireEnvelope;
        };
        await this.storage.storeOfflineEnvelope(
          envelopeId,
          targetDidHash,
          JSON.stringify(envelope),
          this.settings
        );
        this.emit();
        return;
      }

      case 'MSG_FETCH_OFFLINE': {
        const { targetDidHash } = env.payload as { targetDidHash: string };
        const records = await this.storage.fetchOfflineEnvelopes(targetDidHash);
        if (records.length > 0) {
          const reply = this.p2p.createEnvelope(
            'MSG_OFFLINE_BATCH',
            { records },
            env.fromPeerId
          );
          this.p2p.sendEnvelope(reply, env.fromPeerId);
        }
        return;
      }

      case 'MSG_OFFLINE_BATCH': {
        const records = (
          env.payload as {
            records?: Array<{ envelopeId: string; payloadJson: string }>;
          }
        )?.records;
        if (!records) return;
        for (const rec of records) {
          try {
            const inner = JSON.parse(rec.payloadJson) as WireEnvelope;
            await this.handleEnvelope(inner, viaPeerId);
            this.messaging.purgeOfflineEnvelopeOnPeers(rec.envelopeId);
          } catch {
            // ignore corrupted offline item
          }
        }
        return;
      }

      case 'MSG_PURGE_OFFLINE': {
        const { envelopeId } = env.payload as { envelopeId: string };
        if (envelopeId) {
          await this.storage.purgeOfflineEnvelope(envelopeId);
          this.emit();
        }
        return;
      }

      case 'GROUP_KEY_DIST': {
        try {
          const group = await this.messaging.decryptGroupKeyDistribution(
            env,
            this.session.secret
          );
          const idx = this.privateState.groups.findIndex(
            (g) => g.groupId === group.groupId
          );
          if (idx === -1) {
            this.privateState.groups.push(group);
          } else if (group.keyEpoch >= this.privateState.groups[idx].keyEpoch) {
            this.privateState.groups[idx] = group;
          }
          await this.persistPrivateState();
          this.emit();
        } catch {
          // ignore
        }
        return;
      }

      case 'GROUP_MSG': {
        const { groupId } = env.payload as { groupId: string };
        const group = this.privateState.groups.find((g) => g.groupId === groupId);
        if (!group) return;
        try {
          const { content, verified } = await this.messaging.decryptGroupMessage(
            env,
            group
          );
          if (this.privateState.messages.some((m) => m.id === content.messageId)) return;
          const msg: ChatMessage = {
            id: content.messageId,
            conversationId: groupId,
            isGroup: true,
            senderDid: env.fromDid || '',
            senderLogin: content.senderLogin,
            seq: content.createdAt,
            kind: content.kind,
            text: content.text,
            fileManifest: content.fileManifest,
            voiceDurationSec: content.voiceDurationSec,
            createdAt: content.createdAt,
            ttlSeconds: content.ttlSeconds,
            expiresAt: content.ttlSeconds
              ? Date.now() + content.ttlSeconds * 1000
              : undefined,
            status: 'delivered',
            verifiedSignature: verified,
          };
          this.privateState.messages.push(msg);
          if (content.fileManifest) {
            this.privateState.trackedManifests.push(content.fileManifest);
          }
          await this.persistPrivateState();
          this.emit();
        } catch {
          // ignore
        }
        return;
      }

      case 'SHARD_PUT': {
        const { shardId, ownerDidHint, dataBase64 } = env.payload as {
          shardId: string;
          ownerDidHint: string;
          dataBase64: string;
        };
        const bytes = this.replication.decodeIncomingShardPayload(dataBase64);
        const res = await this.storage.putForeignShard(
          shardId,
          bytes,
          ownerDidHint,
          this.settings
        );
        if (!res.accepted && res.reason === 'hash_mismatch') {
          this.security.adjustReputation(
            env.fromPeerId,
            -30,
            'Попытка загрузки блока с неверной контрольной суммой SHA-256'
          );
        }
        const ack = this.p2p.createEnvelope(
          'SHARD_PUT_ACK',
          { shardId, accepted: res.accepted },
          env.fromPeerId
        );
        this.p2p.sendEnvelope(ack, env.fromPeerId);
        this.emit();
        return;
      }

      case 'SHARD_PUT_ACK': {
        const { shardId, accepted } = env.payload as {
          shardId: string;
          accepted: boolean;
        };
        this.fileTransfer.handleShardPutAck(shardId, env.fromPeerId, accepted);
        return;
      }

      case 'SHARD_GET': {
        const { shardId } = env.payload as { shardId: string };
        const bytes = await this.storage.getForeignShard(shardId);
        const reply = this.p2p.createEnvelope(
          'SHARD_DATA',
          {
            shardId,
            dataBase64: bytes ? bytesToBase64(bytes) : null,
          },
          env.fromPeerId
        );
        this.p2p.sendEnvelope(reply, env.fromPeerId);
        this.emit();
        return;
      }

      case 'SHARD_DATA': {
        const { shardId, dataBase64 } = env.payload as {
          shardId: string;
          dataBase64: string | null;
        };
        this.fileTransfer.handleShardData(shardId, env.fromPeerId, dataBase64);
        if (dataBase64) {
          try {
            const raw = this.replication.decodeIncomingShardPayload(dataBase64);
            this.replication.handleShardDataForRepair(shardId, env.fromPeerId, raw);
          } catch {
            this.replication.handleShardDataForRepair(shardId, env.fromPeerId, null);
          }
        } else {
          this.replication.handleShardDataForRepair(shardId, env.fromPeerId, null);
        }
        return;
      }

      case 'SHARD_PROBE': {
        const { shardId } = env.payload as { shardId: string };
        const exists = await this.storage.hasForeignShard(shardId);
        const ack = this.p2p.createEnvelope(
          'SHARD_PROBE_ACK',
          { shardId, exists },
          env.fromPeerId
        );
        this.p2p.sendEnvelope(ack, env.fromPeerId);
        return;
      }

      case 'SHARD_PROBE_ACK': {
        const { shardId, exists } = env.payload as {
          shardId: string;
          exists: boolean;
        };
        this.replication.handleProbeAck(shardId, env.fromPeerId, exists);
        return;
      }
    }
  }
}
