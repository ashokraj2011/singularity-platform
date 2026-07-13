// ─────────────────────────────────────────────────────────────────────────────
// Ed25519 signing helpers for .wgvm images. Uses node:crypto only.
// ─────────────────────────────────────────────────────────────────────────────

import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from 'node:crypto'

export interface SigningKeyPair {
  /** base64 PKCS8 DER private key. */
  privateKey: string
  /** base64 SPKI DER public key. */
  publicKey: string
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }
}

function privateKeyFrom(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' })
}

function publicKeyFrom(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })
}

/** Sign a digest string with an Ed25519 private key. Returns base64 signature. */
export function signDigest(digestHex: string, privateKeyB64: string): string {
  // Ed25519 signs the message directly (algorithm arg must be null).
  const sig = cryptoSign(null, Buffer.from(digestHex, 'utf8'), privateKeyFrom(privateKeyB64))
  return sig.toString('base64')
}

export function verifyDigest(digestHex: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(digestHex, 'utf8'),
      publicKeyFrom(publicKeyB64),
      Buffer.from(signatureB64, 'base64'),
    )
  } catch {
    return false
  }
}
