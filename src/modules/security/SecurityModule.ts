/**
 * Security Module
 *
 * Defends the local node against:
 * - Sybil attacks (anti-Sybil PoW verification on DHT identity announcements)
 * - DDoS / Flooding (sliding-window rate limiting per PeerID)
 * - Corrupted / Tampered storage blocks (SHA-256 content verification)
 * - Malicious peers (reputation scoring, automatic quarantine, manual blocklist)
 */

import { sha256Hex, verifyEd25519 } from '../crypto/CryptoModule';
import { verifyIdentityCard } from '../identity/IdentityModule';
import type {
  IdentityPublicCard,
  NodeSettings,
  SecurityEvent,
  WireEnvelope,
} from '../types';

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

export class SecurityModule {
  private rateBuckets = new Map<string, RateBucket>();
  private reputation = new Map<string, number>(); // peerId -> 0..100
  private blockedPeers = new Set<string>();
  private blockedDids = new Set<string>();
  private seenNonces = new Map<string, number>(); // anti-replay nonce cache
  private events: SecurityEvent[] = [];

  constructor(private getSettings: () => NodeSettings) {}

  setBlockedDids(dids: string[]): void {
    this.blockedDids = new Set(dids);
  }

  isPeerBlocked(peerId: string, did?: string): boolean {
    if (this.blockedPeers.has(peerId)) return true;
    if (did && this.blockedDids.has(did)) return true;
    return false;
  }

  blockPeer(peerId: string, reason: string): void {
    this.blockedPeers.add(peerId);
    this.reputation.set(peerId, 0);
    this.recordEvent('blocked', reason, peerId);
  }

  unblockPeer(peerId: string): void {
    this.blockedPeers.delete(peerId);
    this.reputation.set(peerId, 50);
    this.recordEvent('info', `Узел ${peerId.slice(0, 12)} разблокирован`, peerId);
  }

  getBlockedPeers(): string[] {
    return Array.from(this.blockedPeers);
  }

  getReputation(peerId: string): number {
    return this.reputation.get(peerId) ?? 75;
  }

  adjustReputation(peerId: string, delta: number, reason?: string): number {
    const current = this.getReputation(peerId);
    const next = Math.max(0, Math.min(100, current + delta));
    this.reputation.set(peerId, next);

    if (next <= 15 && this.getSettings().autoQuarantineCorruptPeers) {
      this.blockPeer(peerId, reason || 'Автоматический карантин: низкая репутация узла');
    } else if (delta < 0 && reason) {
      this.recordEvent('warning', reason, peerId);
    }
    return next;
  }

  checkRateLimit(peerId: string): boolean {
    const maxPerMin = Math.max(20, this.getSettings().maxRequestsPerMinutePerPeer);
    const now = Date.now();
    const bucket = this.rateBuckets.get(peerId) ?? {
      tokens: maxPerMin,
      lastRefill: now,
    };

    const elapsedMin = (now - bucket.lastRefill) / 60000;
    bucket.tokens = Math.min(maxPerMin, bucket.tokens + elapsedMin * maxPerMin);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      this.rateBuckets.set(peerId, bucket);
      this.adjustReputation(peerId, -5, 'Превышен лимит запросов (анти-DDoS)');
      return false;
    }

    bucket.tokens -= 1;
    this.rateBuckets.set(peerId, bucket);
    return true;
  }

  checkReplayNonce(nonce: string, timestamp: number): boolean {
    const now = Date.now();
    if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
      // Stale envelope outside 5-minute window
      return false;
    }
    if (this.seenNonces.has(nonce)) {
      return false;
    }
    this.seenNonces.set(nonce, now);
    if (this.seenNonces.size > 5000) {
      for (const [k, ts] of this.seenNonces.entries()) {
        if (now - ts > 5 * 60 * 1000) {
          this.seenNonces.delete(k);
        }
      }
    }
    return true;
  }

  verifyEnvelopeSignature(envelope: WireEnvelope, senderEdPubHex: string): boolean {
    if (!envelope.signature) return false;
    const canonical = JSON.stringify({
      id: envelope.id,
      type: envelope.type,
      fromPeerId: envelope.fromPeerId,
      fromDid: envelope.fromDid,
      targetPeerId: envelope.targetPeerId,
      targetDid: envelope.targetDid,
      timestamp: envelope.timestamp,
      nonce: envelope.nonce,
      payload: envelope.payload,
    });
    return verifyEd25519(envelope.signature, canonical, senderEdPubHex);
  }

  verifyIdentityAnnouncement(card: IdentityPublicCard): boolean {
    if (this.getSettings().requirePowForDiscovery && card.powDifficulty < 8) {
      return false;
    }
    return verifyIdentityCard(card);
  }

  verifyShardIntegrity(expectedShardId: string, bytes: Uint8Array): boolean {
    return sha256Hex(bytes) === expectedShardId;
  }

  recordEvent(severity: SecurityEvent['severity'], reason: string, peerId?: string): void {
    this.events.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      severity,
      peerId,
      reason,
    });
    if (this.events.length > 100) {
      this.events.length = 100;
    }
  }

  getEvents(): SecurityEvent[] {
    return [...this.events];
  }
}
