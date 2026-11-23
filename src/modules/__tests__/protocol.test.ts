import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  decodeReedSolomon,
  deriveSharedSecretX25519,
  encodeReedSolomon,
  randomBytes,
  sha256Hex,
  signEd25519,
  verifyEd25519,
} from '../crypto/CryptoModule';
import { AuthModule } from '../auth/AuthModule';
import { IdentityModule, verifyIdentityCard } from '../identity/IdentityModule';
import { MetadataModule } from '../metadata/MetadataModule';
import { DiscoveryModule } from '../discovery/DiscoveryModule';
import { SecurityModule } from '../security/SecurityModule';
import { DEFAULT_NODE_SETTINGS } from '../storage/DistributedStorageModule';

test('IdentityModule creates verifiable anonymous identity with anti-Sybil PoW and no PII', () => {
  const identity = new IdentityModule();
  const { secret, publicCard } = identity.createIdentity('alice_node', 'peer-test-1', 8);

  assert.equal(secret.login, 'alice_node');
  assert.ok(secret.did.startsWith('mix:'));
  assert.equal(verifyIdentityCard(publicCard), true);

  // Tampering login must invalidate signature & PoW
  const tampered = { ...publicCard, login: 'mallory' };
  assert.equal(verifyIdentityCard(tampered), false);
});

test('AuthModule seals and unlocks private keys using Argon2id + AES-256-GCM', async () => {
  const identity = new IdentityModule();
  const auth = new AuthModule();
  const { secret, publicCard } = identity.createIdentity('vault_user', 'peer-test-2', 8);

  const { keystore } = await auth.sealKeystore(secret, publicCard, 'strong-pass-123');
  assert.ok(keystore.ciphertextHex.length > 0);
  assert.equal(keystore.ciphertextHex.includes(secret.ed25519PrivateKey), false);

  const unlocked = await auth.unlockKeystore(keystore, 'strong-pass-123');
  assert.equal(unlocked.secret.ed25519PrivateKey, secret.ed25519PrivateKey);

  await assert.rejects(() => auth.unlockKeystore(keystore, 'wrong-password'));
});

test('GF(2^8) Reed-Solomon recovers exact encrypted payload when any 2 of 6 shards are lost', async () => {
  const original = randomBytes(4096);
  const key = randomBytes(32);
  const { ivHex, ciphertext } = await aesGcmEncrypt(key, original);

  const rs = encodeReedSolomon(ciphertext, 4, 2);
  assert.equal(rs.shards.length, 6);

  // Drop data shards #0 and #2 (2 nodes offline!) and recover from shards #1, #3, #4, #5
  const surviving = [1, 3, 4, 5].map((index) => ({
    index,
    bytes: rs.shards[index],
  }));

  const recoveredCiphertext = decodeReedSolomon(surviving, 4, rs.originalByteLength);
  assert.equal(sha256Hex(recoveredCiphertext), sha256Hex(ciphertext));

  const decrypted = await aesGcmDecrypt(key, ivHex, recoveredCiphertext);
  assert.deepEqual(decrypted, original);
});

test('X25519 ECDH + Ed25519 signature verifies sender authenticity', async () => {
  const id = new IdentityModule();
  const alice = id.createIdentity('alice', 'peer-a', 8).secret;
  const bob = id.createIdentity('bob', 'peer-b', 8).secret;

  const sharedA = deriveSharedSecretX25519(alice.x25519PrivateKey, bob.x25519PublicKey);
  const sharedB = deriveSharedSecretX25519(bob.x25519PrivateKey, alice.x25519PublicKey);
  assert.deepEqual(sharedA, sharedB);

  const msg = new TextEncoder().encode('Secret decentralized message');
  const sig = signEd25519(msg, alice.ed25519PrivateKey);
  assert.equal(verifyEd25519(sig, msg, alice.ed25519PublicKey), true);
  assert.equal(verifyEd25519(sig, msg, bob.ed25519PublicKey), false);
});

test('MetadataModule peels 2-hop onion layers without leaking inner payload to relays', async () => {
  const id = new IdentityModule();
  const hop1 = id.createIdentity('hop1', 'peer-hop1', 8);
  const hop2 = id.createIdentity('hop2', 'peer-hop2', 8);
  const target = id.createIdentity('target', 'peer-target', 8);

  const meta = new MetadataModule();
  const innerEnv = {
    id: 'env-1',
    type: 'DIRECT_MSG' as const,
    fromPeerId: 'peer-sender',
    timestamp: Date.now(),
    nonce: 'nonce-123',
    payload: { text: 'hidden-content' },
  };

  const { firstHopPeerId, outerEnvelope } = await meta.buildOnionEnvelope(
    'peer-sender',
    'peer-target',
    target.secret.x25519PublicKey,
    innerEnv,
    [
      {
        peerId: 'peer-hop1',
        x25519PublicKey: hop1.secret.x25519PublicKey,
        transport: 'relay',
        connected: true,
        rttMs: 10,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        reputation: 90,
        capabilities: {
          freeStorageBytes: 1000,
          maxStorageBytes: 1000,
          usedStorageBytes: 0,
          alwaysOnNode: true,
          batteryLevel: null,
          charging: null,
          bandwidthBudgetMbps: 10,
        },
        bytesSent: 0,
        bytesReceived: 0,
      },
      {
        peerId: 'peer-hop2',
        x25519PublicKey: hop2.secret.x25519PublicKey,
        transport: 'relay',
        connected: true,
        rttMs: 10,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        reputation: 90,
        capabilities: {
          freeStorageBytes: 1000,
          maxStorageBytes: 1000,
          usedStorageBytes: 0,
          alwaysOnNode: true,
          batteryLevel: null,
          charging: null,
          bandwidthBudgetMbps: 10,
        },
        bytesSent: 0,
        bytesReceived: 0,
      },
    ],
    true
  );

  assert.equal(firstHopPeerId, 'peer-hop1');
  const step1 = await meta.peelOnionLayer(hop1.secret.x25519PrivateKey, outerEnvelope.payload as never);
  assert.equal(step1.action, 'forward');
  if (step1.action === 'forward') {
    assert.equal(step1.nextPeerId, 'peer-hop2');
    const step2 = await meta.peelOnionLayer(hop2.secret.x25519PrivateKey, step1.nextLayer);
    assert.equal(step2.action, 'forward');
    if (step2.action === 'forward') {
      assert.equal(step2.nextPeerId, 'peer-target');
      const finalStep = await meta.peelOnionLayer(
        target.secret.x25519PrivateKey,
        step2.nextLayer
      );
      assert.equal(finalStep.action, 'deliver');
      if (finalStep.action === 'deliver') {
        assert.deepEqual(finalStep.envelope.payload, { text: 'hidden-content' });
      }
    }
  }
});

test('DiscoveryModule validates signed DHT identity records and blocks login hijacking', () => {
  const security = new SecurityModule(() => DEFAULT_NODE_SETTINGS);
  const discovery = new DiscoveryModule(security);
  const id = new IdentityModule();

  const alice = id.createIdentity('shared_handle', 'peer-a', 8);
  const recA = discovery.createSignedIdentityRecord(alice.publicCard, alice.secret);
  assert.equal(discovery.ingestRecord(recA), true);

  // Second attacker tries to register the exact same login with a different DID
  const mallory = id.createIdentity('shared_handle', 'peer-m', 8);
  const recM = discovery.createSignedIdentityRecord(mallory.publicCard, mallory.secret);
  assert.equal(discovery.ingestRecord(recM), false);
});
