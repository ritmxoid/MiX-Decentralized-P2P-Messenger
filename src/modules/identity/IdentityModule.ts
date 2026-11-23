/**
 * Identity Module
 *
 * Manages anonymous decentralized cryptographic identity:
 * - Zero PII (no phone, email, real name, OAuth)
 * - Locally generates Ed25519 + X25519 keypairs
 * - Derives deterministic DID: mix:<first 32 hex chars of SHA-256(ed25519Pub)>
 * - Mines Hashcash-style Proof-of-Work nonce to prevent mass Sybil account creation
 * - Exports & imports encrypted .mixkey identity backups
 */

import {
  generateEd25519Keypair,
  generateX25519Keypair,
  sha256Hex,
  signEd25519,
  verifyEd25519,
} from '../crypto/CryptoModule';
import type {
  BackupFilePayload,
  EncryptedKeystoreRecord,
  IdentityPublicCard,
  LocalIdentitySecret,
} from '../types';

export const DEFAULT_POW_DIFFICULTY = 10; // ~1024 hashes (~3-10ms in JS) to deter automated Sybil floods

export function normalizeLogin(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export function validateLogin(login: string): { valid: boolean; error?: string } {
  const normalized = normalizeLogin(login);
  if (normalized.length < 3 || normalized.length > 28) {
    return { valid: false, error: 'Логин должен содержать от 3 до 28 символов' };
  }
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    return {
      valid: false,
      error: 'Разрешены только латинские буквы, цифры, точка, дефис и подчёркивание',
    };
  }
  return { valid: true };
}

export function canonicalCardString(
  card: Omit<IdentityPublicCard, 'signature'>
): string {
  return JSON.stringify({
    did: card.did,
    login: card.login,
    ed25519PublicKey: card.ed25519PublicKey,
    x25519PublicKey: card.x25519PublicKey,
    peerId: card.peerId,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    powNonce: card.powNonce,
    powDifficulty: card.powDifficulty,
  });
}

export function hasLeadingZeroBits(hexHash: string, bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < hexHash.length && remaining > 0; i++) {
    const nibble = parseInt(hexHash[i], 16);
    if (remaining >= 4) {
      if (nibble !== 0) return false;
      remaining -= 4;
    } else {
      const mask = (0xf << (4 - remaining)) & 0xf;
      if ((nibble & mask) !== 0) return false;
      remaining = 0;
    }
  }
  return true;
}

export function verifyIdentityCard(card: IdentityPublicCard): boolean {
  if (!card || !card.did || !card.ed25519PublicKey || !card.signature) return false;
  const expectedDid = `mix:${sha256Hex(card.ed25519PublicKey).slice(0, 32)}`;
  if (card.did !== expectedDid) return false;

  const powInput = `${card.did}:${card.login}:${card.powNonce}`;
  if (!hasLeadingZeroBits(sha256Hex(powInput), card.powDifficulty)) return false;

  const { signature, ...unsigned } = card;
  return verifyEd25519(signature, canonicalCardString(unsigned), card.ed25519PublicKey);
}

export class IdentityModule {
  createIdentity(
    rawLogin: string,
    peerId: string,
    powDifficulty = DEFAULT_POW_DIFFICULTY
  ): { secret: LocalIdentitySecret; publicCard: IdentityPublicCard } {
    const login = normalizeLogin(rawLogin);
    const check = validateLogin(login);
    if (!check.valid) {
      throw new Error(check.error || 'Некорректный логин');
    }

    const edKeys = generateEd25519Keypair();
    const xKeys = generateX25519Keypair();
    const did = `mix:${sha256Hex(edKeys.publicKeyHex).slice(0, 32)}`;
    const now = Date.now();

    // Mine anti-Sybil PoW nonce
    let powNonce = 0;
    while (true) {
      const candidate = sha256Hex(`${did}:${login}:${powNonce}`);
      if (hasLeadingZeroBits(candidate, powDifficulty)) {
        break;
      }
      powNonce++;
    }

    const secret: LocalIdentitySecret = {
      did,
      login,
      ed25519PrivateKey: edKeys.privateKeyHex,
      ed25519PublicKey: edKeys.publicKeyHex,
      x25519PrivateKey: xKeys.privateKeyHex,
      x25519PublicKey: xKeys.publicKeyHex,
      createdAt: now,
      powNonce,
      powDifficulty,
    };

    const publicCard = this.signPublicCard(secret, peerId);
    return { secret, publicCard };
  }

  signPublicCard(secret: LocalIdentitySecret, peerId: string): IdentityPublicCard {
    const unsigned: Omit<IdentityPublicCard, 'signature'> = {
      did: secret.did,
      login: secret.login,
      ed25519PublicKey: secret.ed25519PublicKey,
      x25519PublicKey: secret.x25519PublicKey,
      peerId,
      createdAt: secret.createdAt,
      updatedAt: Date.now(),
      powNonce: secret.powNonce,
      powDifficulty: secret.powDifficulty,
    };
    const signature = signEd25519(canonicalCardString(unsigned), secret.ed25519PrivateKey);
    return { ...unsigned, signature };
  }

  exportBackup(keystore: EncryptedKeystoreRecord): string {
    const payload: BackupFilePayload = {
      format: 'mix-identity-backup-v1',
      exportedAt: Date.now(),
      keystore,
    };
    return JSON.stringify(payload, null, 2);
  }

  parseBackup(rawJson: string): EncryptedKeystoreRecord {
    let parsed: BackupFilePayload;
    try {
      parsed = JSON.parse(rawJson) as BackupFilePayload;
    } catch {
      throw new Error('Файл резервной копии повреждён (некорректный JSON)');
    }
    if (
      !parsed ||
      parsed.format !== 'mix-identity-backup-v1' ||
      !parsed.keystore ||
      !parsed.keystore.ciphertextHex ||
      !parsed.keystore.publicCard
    ) {
      throw new Error('Неподдерживаемый формат резервной копии MiX');
    }
    if (!verifyIdentityCard(parsed.keystore.publicCard)) {
      throw new Error('Криптографическая подпись идентичности в резервной копии недействительна');
    }
    return parsed.keystore;
  }

  getKeyFingerprint(publicKeyHex: string): string {
    const hash = sha256Hex(publicKeyHex).toUpperCase();
    return hash.match(/.{1,4}/g)?.slice(0, 8).join(' ') ?? hash;
  }
}
