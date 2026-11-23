/**
 * Messaging Module
 *
 * Implements E2EE 1:1 Direct Chats & Private Group Chats:
 * - X25519 + HKDF-SHA256 + AES-256-GCM per-message encryption
 * - Ed25519 sender signature verification
 * - Group chats with forward-secure key rotation (keyEpoch++) on member changes
 * - Offline Store-and-Forward across volunteer peers with automatic purge on ACK
 * - Delivery receipts, read receipts, message editing, deletion, and TTL auto-purge
 * - Multi-hop onion routing integration via MetadataModule
 */

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  deriveSharedSecretX25519,
  hexToBytes,
  randomBytes,
  sha256Hex,
} from '../crypto/CryptoModule';
import type { DiscoveryModule } from '../discovery/DiscoveryModule';
import type { MetadataModule } from '../metadata/MetadataModule';
import type { P2PNetworkModule } from '../p2p/P2PNetworkModule';
import type { SecurityModule } from '../security/SecurityModule';
import type { DistributedStorageModule } from '../storage/DistributedStorageModule';
import type {
  ChatMessage,
  ContactEntry,
  FileManifest,
  GroupChat,
  LocalIdentitySecret,
  MessageKind,
  NodeSettings,
  WireEnvelope,
} from '../types';

export interface EncryptedDirectPayload {
  ivHex: string;
  ciphertextB64: string;
  senderX25519Pub: string;
  seq: number;
}

export interface PlainDirectMessageContent {
  messageId: string;
  kind: MessageKind;
  text: string;
  fileManifest?: FileManifest;
  voiceDurationSec?: number;
  ttlSeconds?: number;
  createdAt: number;
  senderLogin: string;
}

export interface EncryptedGroupPayload {
  groupId: string;
  keyEpoch: number;
  ivHex: string;
  ciphertextB64: string;
}

export class MessagingModule {
  constructor(
    private p2p: P2PNetworkModule,
    private metadata: MetadataModule,
    private storage: DistributedStorageModule,
    private discovery: DiscoveryModule,
    private security: SecurityModule
  ) {}

  async sendDirectEnvelopeWithPrivacy(
    targetPeerId: string,
    targetX25519Pub: string | undefined,
    innerEnvelope: WireEnvelope,
    settings: NodeSettings
  ): Promise<boolean> {
    await this.metadata.applyTimingJitter(settings);

    if (settings.onionRoutingEnabled && targetX25519Pub) {
      const hops = this.metadata.selectOnionRoute(
        this.p2p.getConnectedPeers(),
        targetPeerId,
        settings.onionHops
      );
      if (hops.length > 0) {
        const { firstHopPeerId, outerEnvelope } = await this.metadata.buildOnionEnvelope(
          this.p2p.myPeerId,
          targetPeerId,
          targetX25519Pub,
          innerEnvelope,
          hops,
          settings.fixedPacketPadding
        );
        return this.p2p.sendEnvelope(outerEnvelope, firstHopPeerId);
      }
    }

    return this.p2p.sendEnvelope(innerEnvelope, targetPeerId);
  }

  async buildDirectMessageEnvelope(
    secret: LocalIdentitySecret,
    contact: ContactEntry,
    seq: number,
    content: PlainDirectMessageContent
  ): Promise<WireEnvelope> {
    const shared = deriveSharedSecretX25519(
      secret.x25519PrivateKey,
      contact.x25519PublicKey,
      'mix-dm-v1'
    );
    const plain = new TextEncoder().encode(JSON.stringify(content));
    const { ivHex, ciphertext } = await aesGcmEncrypt(shared, plain);

    const payload: EncryptedDirectPayload = {
      ivHex,
      ciphertextB64: bytesToBase64(ciphertext),
      senderX25519Pub: secret.x25519PublicKey,
      seq,
    };

    return this.p2p.createEnvelope(
      'DIRECT_MSG',
      payload,
      contact.peerId,
      contact.did,
      true
    );
  }

  async decryptDirectEnvelope(
    envelope: WireEnvelope,
    secret: LocalIdentitySecret,
    senderEd25519Pub?: string
  ): Promise<{ content: PlainDirectMessageContent; seq: number; verified: boolean }> {
    const verified = senderEd25519Pub
      ? this.security.verifyEnvelopeSignature(envelope, senderEd25519Pub)
      : false;

    const payload = envelope.payload as EncryptedDirectPayload;
    const shared = deriveSharedSecretX25519(
      secret.x25519PrivateKey,
      payload.senderX25519Pub,
      'mix-dm-v1'
    );

    const plainBytes = await aesGcmDecrypt(
      shared,
      payload.ivHex,
      base64ToBytes(payload.ciphertextB64)
    );
    const content = JSON.parse(
      new TextDecoder().decode(plainBytes)
    ) as PlainDirectMessageContent;

    return { content, seq: payload.seq, verified };
  }

  async storeOfflineForRecipient(
    targetDid: string,
    envelope: WireEnvelope
  ): Promise<boolean> {
    const targetDidHash = sha256Hex(targetDid);
    const peers = this.p2p
      .getConnectedPeers()
      .filter((p) => p.capabilities.freeStorageBytes > 4096)
      .slice(0, 3);

    if (peers.length === 0) return false;

    let storedAnywhere = false;
    for (const peer of peers) {
      const storeEnv = this.p2p.createEnvelope(
        'MSG_STORE_OFFLINE',
        {
          envelopeId: envelope.id,
          targetDidHash,
          envelope,
        },
        peer.peerId
      );
      if (this.p2p.sendEnvelope(storeEnv, peer.peerId)) {
        storedAnywhere = true;
      }
    }
    return storedAnywhere;
  }

  fetchOfflineInboxFromPeers(myDid: string): void {
    const myDidHash = sha256Hex(myDid);
    const env = this.p2p.createEnvelope('MSG_FETCH_OFFLINE', { targetDidHash: myDidHash });
    this.p2p.sendEnvelope(env);
  }

  purgeOfflineEnvelopeOnPeers(envelopeId: string): void {
    const env = this.p2p.createEnvelope('MSG_PURGE_OFFLINE', { envelopeId });
    this.p2p.sendEnvelope(env);
  }

  // ============================================================================
  // Private Group Chats & Forward-Secure Key Rotation
  // ============================================================================

  createGroup(
    name: string,
    creator: LocalIdentitySecret,
    initialMembers: ContactEntry[]
  ): GroupChat {
    const groupKeyHex = bytesToHex(randomBytes(32));
    const groupId = `grp:${sha256Hex(`${creator.did}:${name}:${Date.now()}`).slice(0, 24)}`;
    return {
      groupId,
      name: name.trim(),
      creatorDid: creator.did,
      members: [
        {
          did: creator.did,
          login: creator.login,
          ed25519PublicKey: creator.ed25519PublicKey,
          x25519PublicKey: creator.x25519PublicKey,
        },
        ...initialMembers.map((c) => ({
          did: c.did,
          login: c.login,
          ed25519PublicKey: c.ed25519PublicKey,
          x25519PublicKey: c.x25519PublicKey,
        })),
      ],
      keyEpoch: 1,
      groupKeyHex,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  rotateGroupKey(group: GroupChat): GroupChat {
    return {
      ...group,
      keyEpoch: group.keyEpoch + 1,
      groupKeyHex: bytesToHex(randomBytes(32)),
      updatedAt: Date.now(),
    };
  }

  async distributeGroupKey(
    group: GroupChat,
    secret: LocalIdentitySecret,
    settings: NodeSettings
  ): Promise<void> {
    const groupMeta = {
      groupId: group.groupId,
      name: group.name,
      creatorDid: group.creatorDid,
      members: group.members,
      keyEpoch: group.keyEpoch,
      groupKeyHex: group.groupKeyHex,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };

    for (const member of group.members) {
      if (member.did === secret.did) continue;
      const shared = deriveSharedSecretX25519(
        secret.x25519PrivateKey,
        member.x25519PublicKey,
        'mix-group-key-v1'
      );
      const plain = new TextEncoder().encode(JSON.stringify(groupMeta));
      const { ivHex, ciphertext } = await aesGcmEncrypt(shared, plain);

      const livePeer =
        this.p2p.getPeerByDid(member.did) ||
        this.discovery.getIdentityByDid(member.did);
      const targetPeerId = livePeer?.peerId;

      const env = this.p2p.createEnvelope(
        'GROUP_KEY_DIST',
        {
          ivHex,
          ciphertextB64: bytesToBase64(ciphertext),
          senderX25519Pub: secret.x25519PublicKey,
        },
        targetPeerId,
        member.did,
        true
      );

      if (targetPeerId && this.p2p.getPeer(targetPeerId)?.connected) {
        await this.sendDirectEnvelopeWithPrivacy(
          targetPeerId,
          member.x25519PublicKey,
          env,
          settings
        );
      } else {
        await this.storeOfflineForRecipient(member.did, env);
      }
    }
  }

  async decryptGroupKeyDistribution(
    envelope: WireEnvelope,
    secret: LocalIdentitySecret
  ): Promise<GroupChat> {
    const payload = envelope.payload as {
      ivHex: string;
      ciphertextB64: string;
      senderX25519Pub: string;
    };
    const shared = deriveSharedSecretX25519(
      secret.x25519PrivateKey,
      payload.senderX25519Pub,
      'mix-group-key-v1'
    );
    const plain = await aesGcmDecrypt(
      shared,
      payload.ivHex,
      base64ToBytes(payload.ciphertextB64)
    );
    return JSON.parse(new TextDecoder().decode(plain)) as GroupChat;
  }

  async buildGroupMessageEnvelope(
    secret: LocalIdentitySecret,
    group: GroupChat,
    content: PlainDirectMessageContent
  ): Promise<WireEnvelope> {
    const keyBytes = hexToBytes(group.groupKeyHex);
    const plain = new TextEncoder().encode(JSON.stringify(content));
    const { ivHex, ciphertext } = await aesGcmEncrypt(keyBytes, plain);

    const payload: EncryptedGroupPayload = {
      groupId: group.groupId,
      keyEpoch: group.keyEpoch,
      ivHex,
      ciphertextB64: bytesToBase64(ciphertext),
    };

    return this.p2p.createEnvelope('GROUP_MSG', payload, undefined, undefined, true);
  }

  async decryptGroupMessage(
    envelope: WireEnvelope,
    group: GroupChat
  ): Promise<{ content: PlainDirectMessageContent; verified: boolean }> {
    const payload = envelope.payload as EncryptedGroupPayload;
    if (payload.keyEpoch !== group.keyEpoch) {
      throw new Error('Устаревшая эпоха группового ключа');
    }

    const sender = group.members.find((m) => m.did === envelope.fromDid);
    const verified = sender
      ? this.security.verifyEnvelopeSignature(envelope, sender.ed25519PublicKey)
      : false;

    const plain = await aesGcmDecrypt(
      hexToBytes(group.groupKeyHex),
      payload.ivHex,
      base64ToBytes(payload.ciphertextB64)
    );
    const content = JSON.parse(
      new TextDecoder().decode(plain)
    ) as PlainDirectMessageContent;

    return { content, verified };
  }

  filterExpiredMessages(messages: ChatMessage[]): {
    kept: ChatMessage[];
    changed: boolean;
  } {
    const now = Date.now();
    const kept = messages.filter((m) => !m.expiresAt || m.expiresAt > now);
    return { kept, changed: kept.length !== messages.length };
  }
}
