// ─────────────────────────────────────────────────────────────────────────────
// Image format — build a WorkflowImage from its parts, compute content digests,
// and (de)serialize it to a single deterministic .wgvm envelope.
//
// A .wgvm envelope is canonical JSON of { manifest, payload, signature? }. It is
// deterministic and signable. (OCI packaging wraps this file — Phase 3.)
// ─────────────────────────────────────────────────────────────────────────────

import type { WorkflowDefinition } from '@workgraph/engine'
import type {
  WorkflowImage,
  WorkflowImageManifest,
  WorkflowImagePayload,
  GovernancePolicySnapshot,
  ImageSignature,
} from '../types.js'
import { WGVM_ENGINE_ABI } from '../types.js'
import { canonicalize, digestOf, sha256Hex } from './canonical.js'
import { signDigest } from './sign.js'

/** Deterministic map of logical file path → sha256 hex of its canonical bytes. */
export function computeFileDigests(payload: WorkflowImagePayload): Record<string, string> {
  const digests: Record<string, string> = {
    'workflow.json': digestOf(payload.workflow),
    'policy.json': digestOf(payload.policy),
  }
  for (const [name, content] of Object.entries(payload.assets)) {
    digests[`assets/${name}`] = sha256Hex(content)
  }
  return digests
}

/** Stable hash of a policy snapshot (excludes the policyHash field itself). */
export function computePolicyHash(policy: Omit<GovernancePolicySnapshot, 'policyHash'>): string {
  return digestOf(policy)
}

export interface BuildImageInput {
  workflow: WorkflowDefinition
  policy: Omit<GovernancePolicySnapshot, 'policyHash'>
  assets?: Record<string, string>
  requiredAdapters?: string[]
  builtBy?: string
  /** Optional Ed25519 private key (base64 PKCS8) to sign the image. */
  signingPrivateKeyB64?: string
  signingPublicKeyB64?: string
  keyId?: string
  now?: () => Date
}

/** Compute the digest that a signature is taken over — binds the whole manifest. */
export function signingDigest(manifest: WorkflowImageManifest): string {
  return digestOf(manifest)
}

export function buildImage(input: BuildImageInput): WorkflowImage {
  const policyHash = computePolicyHash(input.policy)
  const policy: GovernancePolicySnapshot = structuredClone({ ...input.policy, policyHash })
  const payload: WorkflowImagePayload = {
    workflow: structuredClone(input.workflow),
    policy,
    assets: structuredClone(input.assets ?? {}),
  }

  const fileDigests = computeFileDigests(payload)
  const nodeTypes = [...new Set(input.workflow.nodes.map(n => n.nodeType))].sort()
  const builtAt = (input.now?.() ?? new Date()).toISOString()

  // Manifest without imageId first, so imageId content-addresses everything else.
  const core: Omit<WorkflowImageManifest, 'imageId'> = {
    format: 'wgvm',
    engineAbi: WGVM_ENGINE_ABI,
    workflowId: input.workflow.workflowId,
    workflowName: input.workflow.name,
    versionHash: input.workflow.versionHash,
    nodeTypes,
    requiredAdapters: [...(input.requiredAdapters ?? [])].sort(),
    policyHash,
    builtAt,
    builtBy: input.builtBy,
    fileDigests,
  }
  const imageId = digestOf(core)
  const manifest: WorkflowImageManifest = { imageId, ...core }

  let signature: ImageSignature | undefined
  if (input.signingPrivateKeyB64 && input.signingPublicKeyB64) {
    signature = {
      algorithm: 'ed25519',
      publicKey: input.signingPublicKeyB64,
      signature: signDigest(signingDigest(manifest), input.signingPrivateKeyB64),
      keyId: input.keyId,
    }
  }

  return { manifest, payload, signature }
}

export function packImage(image: WorkflowImage): string {
  return canonicalize(image)
}

export function unpackImage(serialized: string): WorkflowImage {
  const parsed = JSON.parse(serialized) as WorkflowImage
  if (!parsed || typeof parsed !== 'object' || parsed.manifest?.format !== 'wgvm') {
    throw new Error('not a valid .wgvm image')
  }
  return parsed
}
