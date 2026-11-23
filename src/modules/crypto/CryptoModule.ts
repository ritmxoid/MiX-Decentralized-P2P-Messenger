/**
 * Cryptography Module
 *
 * Implements standard audited cryptographic primitives only:
 * - Ed25519 (RFC 8032) for identity signatures & message authenticity
 * - X25519 (RFC 7748) for Diffie-Hellman key agreement
 * - HKDF-SHA256 for domain-separated key derivation
 * - AES-256-GCM (Web Crypto API) for authenticated encryption
 * - SHA-256 for content-addressed block verification & DHT keys
 * - GF(2^8) Cauchy Reed–Solomon erasure coding for distributed fault tolerance
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  const input = typeof data === 'string' ? encoder.encode(data) : data;
  return sha256(input);
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256Bytes(data));
}

export function generateEd25519Keypair(): { privateKeyHex: string; publicKeyHex: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  return {
    privateKeyHex: bytesToHex(secretKey),
    publicKeyHex: bytesToHex(publicKey),
  };
}

export function generateX25519Keypair(): { privateKeyHex: string; publicKeyHex: string } {
  const { secretKey, publicKey } = x25519.keygen();
  return {
    privateKeyHex: bytesToHex(secretKey),
    publicKeyHex: bytesToHex(publicKey),
  };
}

export function signEd25519(message: Uint8Array | string, privateKeyHex: string): string {
  const msgBytes = typeof message === 'string' ? encoder.encode(message) : message;
  const sig = ed25519.sign(msgBytes, hexToBytes(privateKeyHex));
  return bytesToHex(sig);
}

export function verifyEd25519(
  signatureHex: string,
  message: Uint8Array | string,
  publicKeyHex: string
): boolean {
  try {
    const msgBytes = typeof message === 'string' ? encoder.encode(message) : message;
    return ed25519.verify(hexToBytes(signatureHex), msgBytes, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

export function deriveSharedSecretX25519(
  myPrivateKeyHex: string,
  theirPublicKeyHex: string,
  contextInfo = 'mix-e2ee-v1'
): Uint8Array {
  const rawShared = x25519.getSharedSecret(
    hexToBytes(myPrivateKeyHex),
    hexToBytes(theirPublicKeyHex)
  );
  return hkdf(sha256, rawShared, undefined, encoder.encode(contextInfo), 32);
}

export async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array
): Promise<{ ivHex: string; ciphertext: Uint8Array }> {
  const iv = randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const params: AesGcmParams = aad
    ? { name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: new Uint8Array(aad) }
    : { name: 'AES-GCM', iv: new Uint8Array(iv) };
  const encrypted = await crypto.subtle.encrypt(params, cryptoKey, new Uint8Array(plaintext));
  return {
    ivHex: bytesToHex(iv),
    ciphertext: new Uint8Array(encrypted),
  };
}

export async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  ivHex: string,
  ciphertext: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const iv = hexToBytes(ivHex);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const params: AesGcmParams = aad
    ? { name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: new Uint8Array(aad) }
    : { name: 'AES-GCM', iv: new Uint8Array(iv) };
  const decrypted = await crypto.subtle.decrypt(params, cryptoKey, new Uint8Array(ciphertext));
  return new Uint8Array(decrypted);
}

export async function encryptJsonWithKey(
  keyBytes: Uint8Array,
  payload: unknown,
  aadText?: string
): Promise<{ ivHex: string; ciphertextHex: string }> {
  const plain = encoder.encode(JSON.stringify(payload));
  const aad = aadText ? encoder.encode(aadText) : undefined;
  const { ivHex, ciphertext } = await aesGcmEncrypt(keyBytes, plain, aad);
  return { ivHex, ciphertextHex: bytesToHex(ciphertext) };
}

export async function decryptJsonWithKey<T>(
  keyBytes: Uint8Array,
  ivHex: string,
  ciphertextHex: string,
  aadText?: string
): Promise<T> {
  const aad = aadText ? encoder.encode(aadText) : undefined;
  const plain = await aesGcmDecrypt(keyBytes, ivHex, hexToBytes(ciphertextHex), aad);
  return JSON.parse(decoder.decode(plain)) as T;
}

// ============================================================================
// Genuine GF(2^8) Cauchy Reed–Solomon Erasure Coding (MDS Code)
// Primitive polynomial: x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
// ============================================================================

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfInv(a: number): number {
  if (a === 0) throw new Error('Division by zero in GF(2^8)');
  return GF_EXP[255 - GF_LOG[a]];
}

function buildGeneratorRow(rowIdx: number, k: number): Uint8Array {
  const row = new Uint8Array(k);
  if (rowIdx < k) {
    row[rowIdx] = 1;
    return row;
  }
  // Cauchy row: x_i = rowIdx (in [k..n-1]), y_j = j (in [0..k-1])
  for (let j = 0; j < k; j++) {
    row[j] = gfInv(rowIdx ^ j);
  }
  return row;
}

function invertGfMatrix(matrix: Uint8Array[], size: number): Uint8Array[] {
  const aug: Uint8Array[] = matrix.map((r, i) => {
    const full = new Uint8Array(size * 2);
    full.set(r, 0);
    full[size + i] = 1;
    return full;
  });

  for (let col = 0; col < size; col++) {
    let pivotRow = -1;
    for (let r = col; r < size; r++) {
      if (aug[r][col] !== 0) {
        pivotRow = r;
        break;
      }
    }
    if (pivotRow === -1) {
      throw new Error('Singular matrix in Reed-Solomon recovery');
    }
    if (pivotRow !== col) {
      const tmp = aug[col];
      aug[col] = aug[pivotRow];
      aug[pivotRow] = tmp;
    }

    const invPivot = gfInv(aug[col][col]);
    for (let c = 0; c < size * 2; c++) {
      aug[col][c] = gfMul(aug[col][c], invPivot);
    }

    for (let r = 0; r < size; r++) {
      if (r === col || aug[r][col] === 0) continue;
      const factor = aug[r][col];
      for (let c = 0; c < size * 2; c++) {
        aug[r][c] ^= gfMul(factor, aug[col][c]);
      }
    }
  }

  return aug.map((r) => r.slice(size));
}

export interface ReedSolomonEncoded {
  shards: Uint8Array[]; // k + m equal-length shards
  shardSize: number;
  originalByteLength: number;
}

/**
 * Encodes arbitrary ciphertext bytes into (dataShards + parityShards) shards.
 * Any `dataShards` subset of the total shards can reconstruct the exact original bytes.
 */
export function encodeReedSolomon(
  data: Uint8Array,
  dataShards: number,
  parityShards: number
): ReedSolomonEncoded {
  if (dataShards < 1 || parityShards < 0 || dataShards + parityShards > 255) {
    throw new Error('Invalid Reed-Solomon parameters');
  }
  const shardSize = Math.max(1, Math.ceil(data.length / dataShards));
  const padded = new Uint8Array(shardSize * dataShards);
  padded.set(data, 0);

  const shards: Uint8Array[] = [];
  for (let i = 0; i < dataShards; i++) {
    shards.push(padded.slice(i * shardSize, (i + 1) * shardSize));
  }

  for (let p = 0; p < parityShards; p++) {
    const genRow = buildGeneratorRow(dataShards + p, dataShards);
    const parity = new Uint8Array(shardSize);
    for (let j = 0; j < dataShards; j++) {
      const coeff = genRow[j];
      if (coeff === 0) continue;
      const src = shards[j];
      for (let b = 0; b < shardSize; b++) {
        parity[b] ^= gfMul(coeff, src[b]);
      }
    }
    shards.push(parity);
  }

  return {
    shards,
    shardSize,
    originalByteLength: data.length,
  };
}

/**
 * Reconstructs the original payload from any >= `dataShards` available shards.
 */
export function decodeReedSolomon(
  availableShards: Array<{ index: number; bytes: Uint8Array }>,
  dataShards: number,
  originalByteLength: number
): Uint8Array {
  if (availableShards.length < dataShards) {
    throw new Error(
      `Insufficient shards for Reed-Solomon recovery: need ${dataShards}, got ${availableShards.length}`
    );
  }

  const sorted = [...availableShards].sort((a, b) => a.index - b.index).slice(0, dataShards);
  const shardSize = sorted[0].bytes.length;

  // Fast path: all k data shards [0..k-1] are intact
  const isSystematicComplete = sorted.every((s, idx) => s.index === idx);
  if (isSystematicComplete) {
    const out = new Uint8Array(dataShards * shardSize);
    for (let i = 0; i < dataShards; i++) {
      out.set(sorted[i].bytes, i * shardSize);
    }
    return out.slice(0, originalByteLength);
  }

  // Matrix inversion recovery over GF(2^8)
  const subMatrix = sorted.map((s) => buildGeneratorRow(s.index, dataShards));
  const invMatrix = invertGfMatrix(subMatrix, dataShards);

  const recovered = new Uint8Array(dataShards * shardSize);
  for (let i = 0; i < dataShards; i++) {
    const targetOffset = i * shardSize;
    const invRow = invMatrix[i];
    for (let j = 0; j < dataShards; j++) {
      const coeff = invRow[j];
      if (coeff === 0) continue;
      const src = sorted[j].bytes;
      for (let b = 0; b < shardSize; b++) {
        recovered[targetOffset + b] ^= gfMul(coeff, src[b]);
      }
    }
  }

  return recovered.slice(0, originalByteLength);
}
