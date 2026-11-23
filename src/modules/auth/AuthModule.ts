/**
 * Authentication Module
 *
 * Purely local authentication without any central auth server.
 * Uses Argon2id (RFC 9106) memory-hard KDF to derive an AES-256-GCM wrapping key
 * from the user's password + random 16-byte salt, unlocking the local keystore.
 */

import { argon2idAsync } from '@noble/hashes/argon2.js';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  bytesToHex,
  hexToBytes,
  randomBytes,
} from '../crypto/CryptoModule';
import type {
  EncryptedKeystoreRecord,
  IdentityPublicCard,
  LocalIdentitySecret,
} from '../types';

export interface DecryptedVaultSession {
  secret: LocalIdentitySecret;
  publicCard: IdentityPublicCard;
  localVaultKey: Uint8Array; // Derived key used to encrypt local chat/contact DB at rest
}

const DEFAULT_ARGON2_PARAMS = {
  t: 2,
  m: 16384, // 16 MiB memory-hard cost suitable for mobile/browser responsiveness
  p: 1,
};

export class AuthModule {
  async deriveMasterKey(
    password: string,
    saltHex: string,
    params = DEFAULT_ARGON2_PARAMS
  ): Promise<Uint8Array> {
    if (!password || password.length < 6) {
      throw new Error('Пароль должен содержать минимум 6 символов');
    }
    return argon2idAsync(password, hexToBytes(saltHex), {
      t: params.t,
      m: params.m,
      p: params.p,
      dkLen: 32,
      asyncTick: 10,
    });
  }

  async sealKeystore(
    secret: LocalIdentitySecret,
    publicCard: IdentityPublicCard,
    password: string
  ): Promise<{ keystore: EncryptedKeystoreRecord; localVaultKey: Uint8Array }> {
    const saltHex = bytesToHex(randomBytes(16));
    const params = { ...DEFAULT_ARGON2_PARAMS };
    const masterKey = await this.deriveMasterKey(password, saltHex, params);

    const payloadBytes = new TextEncoder().encode(JSON.stringify(secret));
    const aad = new TextEncoder().encode(secret.did);
    const { ivHex, ciphertext } = await aesGcmEncrypt(masterKey, payloadBytes, aad);

    const keystore: EncryptedKeystoreRecord = {
      version: 1,
      login: secret.login,
      did: secret.did,
      saltHex,
      argon2Params: params,
      ivHex,
      ciphertextHex: bytesToHex(ciphertext),
      publicCard,
    };

    return { keystore, localVaultKey: masterKey };
  }

  async unlockKeystore(
    keystore: EncryptedKeystoreRecord,
    password: string
  ): Promise<DecryptedVaultSession> {
    const masterKey = await this.deriveMasterKey(
      password,
      keystore.saltHex,
      keystore.argon2Params
    );

    try {
      const aad = new TextEncoder().encode(keystore.did);
      const plainBytes = await aesGcmDecrypt(
        masterKey,
        keystore.ivHex,
        hexToBytes(keystore.ciphertextHex),
        aad
      );
      const secret = JSON.parse(new TextDecoder().decode(plainBytes)) as LocalIdentitySecret;
      return {
        secret,
        publicCard: keystore.publicCard,
        localVaultKey: masterKey,
      };
    } catch {
      throw new Error('Неверный пароль или повреждённая локальная связка ключей');
    }
  }
}
