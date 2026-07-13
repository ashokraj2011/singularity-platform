// ─────────────────────────────────────────────────────────────────────────────
// Loader — fail-closed verification of a .wgvm image before it may run.
//
// Verification steps (any failure throws — the VM never runs an unverified image):
//   1. engine ABI matches this VM build
//   2. every payload file hashes to the digest recorded in the manifest
//   3. the manifest's imageId content-addresses the manifest core
//   4. policyHash matches the embedded policy
//   5. if a signature is present, it verifies over the manifest digest
//   6. if requireSignature is set, an image without a valid signature is rejected
// ─────────────────────────────────────────────────────────────────────────────

import type { WorkflowImage } from '../types.js'
import { WGVM_ENGINE_ABI } from '../types.js'
import { digestOf } from './canonical.js'
import { verifyDigest } from './sign.js'
import {
  computeFileDigests,
  computePolicyHash,
  signingDigest,
  unpackImage,
} from './format.js'

export class ImageVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageVerificationError'
  }
}

export interface VerifyOptions {
  /** Reject any image that is unsigned or whose signature does not verify. */
  requireSignature?: boolean
  /** If provided, the signer public key must be in this allow-list. */
  trustedPublicKeys?: string[]
}

export function verifyImage(image: WorkflowImage, opts: VerifyOptions = {}): void {
  const { manifest, payload, signature } = image

  if (manifest.engineAbi !== WGVM_ENGINE_ABI) {
    throw new ImageVerificationError(
      `engine ABI mismatch: image=${manifest.engineAbi} vm=${WGVM_ENGINE_ABI}`,
    )
  }

  // 2. file digests
  const recomputed = computeFileDigests(payload)
  const declaredKeys = Object.keys(manifest.fileDigests).sort()
  const actualKeys = Object.keys(recomputed).sort()
  if (declaredKeys.join('|') !== actualKeys.join('|')) {
    throw new ImageVerificationError('payload file set does not match manifest')
  }
  for (const key of actualKeys) {
    if (manifest.fileDigests[key] !== recomputed[key]) {
      throw new ImageVerificationError(`digest mismatch for ${key}`)
    }
  }

  // 3. imageId content-addresses the manifest core
  const { imageId, ...core } = manifest
  if (digestOf(core) !== imageId) {
    throw new ImageVerificationError('imageId does not match manifest contents')
  }

  // 4. policy hash
  const { policyHash: _ph, ...policyCore } = payload.policy
  if (computePolicyHash(policyCore) !== manifest.policyHash || payload.policy.policyHash !== manifest.policyHash) {
    throw new ImageVerificationError('policy hash mismatch')
  }

  // 5 + 6. signature
  if (signature) {
    if (signature.algorithm !== 'ed25519') {
      throw new ImageVerificationError(`unsupported signature algorithm ${signature.algorithm}`)
    }
    const ok = verifyDigest(signingDigest(manifest), signature.signature, signature.publicKey)
    if (!ok) throw new ImageVerificationError('signature verification failed')
    if (opts.trustedPublicKeys && !opts.trustedPublicKeys.includes(signature.publicKey)) {
      throw new ImageVerificationError('signer public key is not trusted')
    }
  } else if (opts.requireSignature) {
    throw new ImageVerificationError('image is unsigned but a signature is required')
  }
}

/** Parse + verify in one step. Returns the verified image or throws. */
export function loadImage(serialized: string, opts: VerifyOptions = {}): WorkflowImage {
  const image = unpackImage(serialized)
  verifyImage(image, opts)
  return image
}
