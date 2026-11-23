/**
 * Metadata Protection Module
 *
 * Mitigates IP exposure and traffic-analysis metadata leaks:
 * 1. Multi-hop Onion Routing (1–2 volunteer intermediate peers):
 *    Sender -> Hop 1 -> [Hop 2] -> Target.
 *    Each layer is encrypted using ephemeral X25519 ECDH + AES-256-GCM so
 *    intermediate nodes only see the next hop ID, never the inner message or origin.
 * 2. Fixed-Bucket Packet Padding:
 *    Pads payloads to fixed buckets (1 KB / 4 KB / 16 KB / 64 KB) to prevent
 *    packet-length fingerprinting.
 * 3. Optional Randomized Jitter:
 *    Adds small random delay before transmission to blur timing correlation.
 */

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  base64ToBytes,
  bytesToBase64,
  deriveSharedSecretX25519,
  generateX25519Keypair,
} from '../crypto/CryptoModule';
import type { NodeSettings, PeerInfo, WireEnvelope } from '../types';

export interface OnionLayerPayload {
  ephemeralX25519Pub: string;
  ivHex: string;
  ciphertextB64: string;
}

interface DecryptedOnionInstruction {
  nextPeerId: string | null; // null => final destination reached
  innerPacket: WireEnvelope | OnionLayerPayload;
}

const PADDING_BUCKETS = [1024, 4096, 16384, 65536];

export class MetadataModule {
  padToFixedBucket(jsonText: string): string {
    const raw = new TextEncoder().encode(jsonText);
    const needed = raw.length + 4; // 4-byte length prefix
    const bucket =
      PADDING_BUCKETS.find((b) => b >= needed) ?? Math.ceil(needed / 16384) * 16384;
    const padded = new Uint8Array(bucket);
    const view = new DataView(padded.buffer);
    view.setUint32(0, raw.length, false);
    padded.set(raw, 4);
    if (bucket > needed) {
      crypto.getRandomValues(padded.subarray(needed));
    }
    return bytesToBase64(padded);
  }

  unpadFromFixedBucket(b64: string): string {
    const padded = base64ToBytes(b64);
    const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
    const len = view.getUint32(0, false);
    if (len > padded.length - 4) {
      throw new Error('Invalid padded packet length');
    }
    const raw = padded.subarray(4, 4 + len);
    return new TextDecoder().decode(raw);
  }

  async applyTimingJitter(settings: NodeSettings): Promise<void> {
    if (settings.timingJitterMs <= 0) return;
    const delay = Math.floor(Math.random() * settings.timingJitterMs);
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /**
   * Selects volunteer relay hops from connected peers excluding sender and target.
   */
  selectOnionRoute(
    peers: PeerInfo[],
    targetPeerId: string,
    hopCount: 1 | 2
  ): PeerInfo[] {
    const candidates = peers.filter(
      (p) =>
        p.connected &&
        p.peerId !== targetPeerId &&
        typeof p.x25519PublicKey === 'string' &&
        p.reputation >= 40
    );
    if (candidates.length === 0) return [];
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(hopCount, shuffled.length));
  }

  /**
   * Wraps an inner WireEnvelope in an onion route through selected intermediate hops.
   */
  async buildOnionEnvelope(
    myPeerId: string,
    finalTargetPeerId: string,
    finalTargetX25519Pub: string,
    innerEnvelope: WireEnvelope,
    hops: PeerInfo[],
    fixedPadding: boolean
  ): Promise<{ firstHopPeerId: string; outerEnvelope: WireEnvelope }> {
    const serializedInner = fixedPadding
      ? this.padToFixedBucket(JSON.stringify(innerEnvelope))
      : JSON.stringify(innerEnvelope);

    // Final layer encrypted for target peer
    let currentLayer = await this.encryptLayer(finalTargetX25519Pub, {
      nextPeerId: null,
      innerPacket: fixedPadding
        ? ({ padded: serializedInner } as unknown as WireEnvelope)
        : innerEnvelope,
    });

    let nextTarget = finalTargetPeerId;

    // Wrap in reverse order: Hop_N ... Hop_1
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i];
      if (!hop.x25519PublicKey) continue;
      currentLayer = await this.encryptLayer(hop.x25519PublicKey, {
        nextPeerId: nextTarget,
        innerPacket: currentLayer,
      });
      nextTarget = hop.peerId;
    }

    const outerEnvelope: WireEnvelope = {
      id: `onion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'ONION_HOP',
      fromPeerId: myPeerId,
      targetPeerId: nextTarget,
      timestamp: Date.now(),
      nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      payload: currentLayer,
    };

    return { firstHopPeerId: nextTarget, outerEnvelope };
  }

  private async encryptLayer(
    recipientX25519Pub: string,
    instruction: DecryptedOnionInstruction
  ): Promise<OnionLayerPayload> {
    const eph = generateX25519Keypair();
    const shared = deriveSharedSecretX25519(
      eph.privateKeyHex,
      recipientX25519Pub,
      'mix-onion-layer-v1'
    );
    const plain = new TextEncoder().encode(JSON.stringify(instruction));
    const { ivHex, ciphertext } = await aesGcmEncrypt(shared, plain);
    return {
      ephemeralX25519Pub: eph.publicKeyHex,
      ivHex,
      ciphertextB64: bytesToBase64(ciphertext),
    };
  }

  async peelOnionLayer(
    myX25519PrivKey: string,
    layer: OnionLayerPayload
  ): Promise<
    | { action: 'forward'; nextPeerId: string; nextLayer: OnionLayerPayload }
    | { action: 'deliver'; envelope: WireEnvelope }
  > {
    const shared = deriveSharedSecretX25519(
      myX25519PrivKey,
      layer.ephemeralX25519Pub,
      'mix-onion-layer-v1'
    );
    const plainBytes = await aesGcmDecrypt(
      shared,
      layer.ivHex,
      base64ToBytes(layer.ciphertextB64)
    );
    const decoded = JSON.parse(
      new TextDecoder().decode(plainBytes)
    ) as DecryptedOnionInstruction;

    if (decoded.nextPeerId) {
      return {
        action: 'forward',
        nextPeerId: decoded.nextPeerId,
        nextLayer: decoded.innerPacket as OnionLayerPayload,
      };
    }

    const innerObj = decoded.innerPacket as unknown as { padded?: string } & WireEnvelope;
    if (typeof innerObj.padded === 'string') {
      const jsonStr = this.unpadFromFixedBucket(innerObj.padded);
      return { action: 'deliver', envelope: JSON.parse(jsonStr) as WireEnvelope };
    }
    return { action: 'deliver', envelope: innerObj as WireEnvelope };
  }
}
