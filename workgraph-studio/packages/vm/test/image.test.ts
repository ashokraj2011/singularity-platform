import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WorkflowDefinition } from '@workgraph/engine'
import {
  buildImage,
  packImage,
  loadImage,
  verifyImage,
  ImageVerificationError,
  generateSigningKeyPair,
} from '../src/index.js'

const workflow: WorkflowDefinition = {
  workflowId: 'wf-1',
  versionHash: 'v1',
  name: 'Test WF',
  nodes: [
    { id: 'start', nodeType: 'START' },
    { id: 'end', nodeType: 'END' },
  ],
  edges: [{ id: 'e1', sourceNodeId: 'start', targetNodeId: 'end', edgeType: 'SEQUENTIAL' }],
}

const policy = {
  gatedNodeTypes: [],
  allowedCapabilities: [],
  approvalRequiredNodeTypes: [],
  failClosed: true,
}

test('build + load round-trips and verifies', () => {
  const image = buildImage({ workflow, policy })
  const serialized = packImage(image)
  const loaded = loadImage(serialized)
  assert.equal(loaded.manifest.workflowId, 'wf-1')
  assert.equal(loaded.manifest.engineAbi, 1)
  assert.ok(loaded.manifest.imageId.length === 64)
})

test('signed image verifies with a signature', () => {
  const kp = generateSigningKeyPair()
  const image = buildImage({
    workflow,
    policy,
    signingPrivateKeyB64: kp.privateKey,
    signingPublicKeyB64: kp.publicKey,
  })
  assert.ok(image.signature)
  verifyImage(image, { requireSignature: true })
})

test('tampering with the workflow is rejected (fail-closed)', () => {
  const image = buildImage({ workflow, policy })
  // Mutate the payload after the manifest digests were computed.
  image.payload.workflow.name = 'HACKED'
  assert.throws(() => verifyImage(image), ImageVerificationError)
})

test('tampering with a signed manifest breaks the signature', () => {
  const kp = generateSigningKeyPair()
  const image = buildImage({
    workflow,
    policy,
    signingPrivateKeyB64: kp.privateKey,
    signingPublicKeyB64: kp.publicKey,
  })
  image.manifest.workflowName = 'HACKED'
  assert.throws(() => verifyImage(image), ImageVerificationError)
})

test('unsigned image rejected when signature required', () => {
  const image = buildImage({ workflow, policy })
  assert.throws(() => verifyImage(image, { requireSignature: true }), ImageVerificationError)
})

test('untrusted signer rejected', () => {
  const kp = generateSigningKeyPair()
  const other = generateSigningKeyPair()
  const image = buildImage({
    workflow,
    policy,
    signingPrivateKeyB64: kp.privateKey,
    signingPublicKeyB64: kp.publicKey,
  })
  assert.throws(
    () => verifyImage(image, { trustedPublicKeys: [other.publicKey] }),
    ImageVerificationError,
  )
})
