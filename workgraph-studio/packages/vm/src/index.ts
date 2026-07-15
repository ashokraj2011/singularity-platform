// ─────────────────────────────────────────────────────────────────────────────
// @workgraph/vm — portable Workflow VM: build a workflow into a signed, self-
// contained image and execute it anywhere, online or offline.
// ─────────────────────────────────────────────────────────────────────────────

export * from './types.js'

// Image format + trust
export { canonicalize, digestOf, sha256Hex } from './image/canonical.js'
export {
  generateSigningKeyPair,
  signDigest,
  verifyDigest,
  type SigningKeyPair,
} from './image/sign.js'
export {
  buildImage,
  packImage,
  unpackImage,
  computeFileDigests,
  computePolicyHash,
  signingDigest,
  type BuildImageInput,
} from './image/format.js'
export {
  loadImage,
  verifyImage,
  ImageVerificationError,
  type VerifyOptions,
} from './image/loader.js'

// State
export type { StateStore, OutboxEntry } from './state/StateStore.js'
export { SqliteStateStore } from './state/SqliteStateStore.js'

// Adapters
export { offlineAdapters, queuingAuditAdapter, systemClock } from './adapters/offline.js'
export { httpAdapters, mergeAdapters, type HttpAdapterConfig, type HttpEndpoint } from './adapters/http.js'

// Executors
export { ExecutorRegistry, defaultRegistry } from './executors/registry.js'
export { setContextExecutor, structuralExecutor } from './executors/deterministic.js'
export { humanTaskExecutor, governanceGateExecutor } from './executors/serviceBound.js'
export { llmTaskExecutor, toolRequestExecutor, gitExecutor } from './executors/tasks.js'
export { timerExecutor } from './executors/timer.js'
export { discoveryExecutor, readSeedQuestions, hasBlockingOpen } from './executors/discovery.js'

// Builder
export {
  buildImageFromDesignGraph,
  toWorkflowDefinition,
  requiredAdaptersFor,
  type DesignGraph,
  type DesignGraphNode,
  type DesignGraphEdge,
  type WorkflowMeta,
  type BuildFromDesignGraphInput,
} from './builder/fromDesignGraph.js'

// Sync
export { syncOutbox, type SyncTarget, type SyncResult } from './sync/receiptSync.js'

// Runtime
export { WorkflowVm, type WorkflowVmOptions } from './WorkflowVm.js'
