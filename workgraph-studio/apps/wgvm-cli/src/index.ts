#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// wgvm — build, verify, run, resume and sync portable Workflow VM images.
//
//   wgvm keygen [--out key.json]
//   wgvm build  --input spec.json --out image.wgvm [--keypair key.json] [--by name]
//   wgvm build  --from-api URL --workflow-id ID [--token T] --out image.wgvm [...]
//   wgvm verify image.wgvm [--require-signature] [--trusted pub.txt]
//   wgvm run    image.wgvm [--inputs in.json] [--state run.db] [--run ID]
//                          [--iam-url U --iam-token T] [--llm-url ...] [--tool-url ...]
//                          [--git-url ...] [--human-url ...] [--audit-url ...]
//                          [--sign-receipts priv.txt]
//   wgvm status --state run.db --run ID
//   wgvm resume image.wgvm --run ID --state run.db [online flags…]
//   wgvm sync   --state run.db --audit-url URL [--audit-token T]
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile } from 'node:fs/promises'
import {
  buildImageFromDesignGraph,
  packImage,
  loadImage,
  verifyImage,
  generateSigningKeyPair,
  WorkflowVm,
  SqliteStateStore,
  offlineAdapters,
  httpAdapters,
  mergeAdapters,
  syncOutbox,
  type Adapters,
  type HttpAdapterConfig,
  type GovernancePolicySnapshot,
} from '@workgraph/vm'

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else {
        flags[key] = next
        i++
      }
    } else {
      _.push(a)
    }
  }
  return { _, flags }
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

const DEFAULT_POLICY: Omit<GovernancePolicySnapshot, 'policyHash'> = {
  gatedNodeTypes: [],
  allowedCapabilities: [],
  approvalRequiredNodeTypes: [],
  failClosed: true,
}

// ── online adapters from flags ───────────────────────────────────────────────

function onlineAdaptersFromFlags(store: SqliteStateStore, flags: Record<string, string | boolean>): Adapters {
  const ep = (u: string, t: string) => {
    const baseUrl = str(flags[u])
    return baseUrl ? { baseUrl, token: str(flags[t]) } : undefined
  }
  const cfg: HttpAdapterConfig = {
    iam: ep('iam-url', 'iam-token'),
    llm: ep('llm-url', 'llm-token'),
    tool: ep('tool-url', 'tool-token'),
    git: ep('git-url', 'git-token'),
    human: ep('human-url', 'human-token'),
    audit: ep('audit-url', 'audit-token'),
  }
  return mergeAdapters(httpAdapters(cfg), offlineAdapters(store))
}

// ── commands ──────────────────────────────────────────────────────────────────

async function cmdKeygen(flags: Record<string, string | boolean>): Promise<void> {
  const kp = generateSigningKeyPair()
  const out = str(flags.out)
  if (out) {
    await writeFile(out, JSON.stringify(kp, null, 2), 'utf8')
    console.log(`wrote signing keypair to ${out}`)
  } else {
    console.log(JSON.stringify(kp, null, 2))
  }
}

interface BuildSpec {
  workflow: { id: string; name: string; currentVersion?: string | number; updatedAt?: string; variables?: unknown[] }
  graph: { nodes: unknown[]; edges: unknown[] }
  globals?: Record<string, unknown>
  policy?: Omit<GovernancePolicySnapshot, 'policyHash'>
  assets?: Record<string, string>
}

async function fetchFromApi(base: string, workflowId: string, token?: string): Promise<BuildSpec> {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  const get = async (path: string) => {
    const res = await fetch(`${base.replace(/\/$/, '')}${path}`, { headers })
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
    return res.json()
  }
  const wf = (await get(`/workflow-templates/${workflowId}`)) as any
  const graph = (await get(`/workflow-templates/${workflowId}/design-graph`)) as any
  return {
    workflow: { id: workflowId, name: wf.name, currentVersion: wf.currentVersion, updatedAt: wf.updatedAt, variables: wf.variables },
    graph: { nodes: graph.nodes ?? [], edges: graph.edges ?? [] },
    globals: {},
  }
}

async function cmdBuild(flags: Record<string, string | boolean>): Promise<void> {
  const out = str(flags.out)
  if (!out) throw new Error('build requires --out <image.wgvm>')

  let spec: BuildSpec
  const inputPath = str(flags.input)
  const fromApi = str(flags['from-api'])
  if (inputPath) {
    spec = await readJson<BuildSpec>(inputPath)
  } else if (fromApi) {
    const workflowId = str(flags['workflow-id'])
    if (!workflowId) throw new Error('--from-api requires --workflow-id')
    spec = await fetchFromApi(fromApi, workflowId, str(flags.token))
  } else {
    throw new Error('build requires --input <spec.json> or --from-api <url> --workflow-id <id>')
  }

  let signingPrivateKeyB64: string | undefined
  let signingPublicKeyB64: string | undefined
  const keypairPath = str(flags.keypair)
  if (keypairPath) {
    const kp = await readJson<{ privateKey: string; publicKey: string }>(keypairPath)
    signingPrivateKeyB64 = kp.privateKey
    signingPublicKeyB64 = kp.publicKey
  }

  const image = buildImageFromDesignGraph({
    workflow: spec.workflow as any,
    graph: spec.graph as any,
    globals: spec.globals,
    policy: spec.policy ?? DEFAULT_POLICY,
    assets: spec.assets,
    signingPrivateKeyB64,
    signingPublicKeyB64,
    builtBy: str(flags.by),
  })
  await writeFile(out, packImage(image), 'utf8')
  console.log(`built ${out}`)
  console.log(`  imageId: ${image.manifest.imageId}`)
  console.log(`  workflow: ${image.manifest.workflowName} (${image.manifest.workflowId}@${image.manifest.versionHash})`)
  console.log(`  nodeTypes: ${image.manifest.nodeTypes.join(', ')}`)
  console.log(`  requiredAdapters: ${image.manifest.requiredAdapters.join(', ') || 'none'}`)
  console.log(`  signed: ${image.signature ? 'yes' : 'no'}`)
}

async function cmdVerify(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const path = positional[0]
  if (!path) throw new Error('verify requires an image path')
  const trustedPath = str(flags.trusted)
  const trustedPublicKeys = trustedPath ? [(await readFile(trustedPath, 'utf8')).trim()] : undefined
  const image = loadImage(await readFile(path, 'utf8'), {
    requireSignature: flags['require-signature'] === true,
    trustedPublicKeys,
  })
  console.log(`OK ${path}`)
  console.log(`  imageId: ${image.manifest.imageId}`)
  console.log(`  signed: ${image.signature ? 'yes' : 'no'}`)
}

function summarize(state: any): void {
  console.log(`run ${state.runId}: ${state.status}`)
  for (const n of Object.values(state.nodes) as any[]) {
    console.log(`  ${n.nodeId.padEnd(16)} ${n.status}${n.blockedReason ? ` (${n.blockedReason})` : ''}${n.failureReason ? ` (${n.failureReason})` : ''}`)
  }
}

async function cmdRun(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const path = positional[0]
  if (!path) throw new Error('run requires an image path')
  const image = loadImage(await readFile(path, 'utf8'), { requireSignature: flags['require-signature'] === true })

  const store = new SqliteStateStore(str(flags.state) ?? ':memory:')
  store.init()
  const adapters = onlineAdaptersFromFlags(store, flags)

  let receiptSigningKeyB64: string | undefined
  const rk = str(flags['sign-receipts'])
  if (rk) receiptSigningKeyB64 = (await readFile(rk, 'utf8')).trim()

  const inputs = str(flags.inputs) ? await readJson<Record<string, unknown>>(str(flags.inputs)!) : {}
  const vm = new WorkflowVm({ image, store, adapters, receiptSigningKeyB64, onLog: e => console.error(`[${e.kind}] ${e.nodeId ?? ''} ${e.message ?? ''}`) })
  const state = await vm.start(inputs, { runId: str(flags.run) })
  summarize(state)
  store.close()
}

async function cmdResume(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const path = positional[0]
  const runId = str(flags.run)
  if (!path || !runId) throw new Error('resume requires an image path and --run <id>')
  const image = loadImage(await readFile(path, 'utf8'))
  const store = new SqliteStateStore(str(flags.state) ?? ':memory:')
  store.init()
  const adapters = onlineAdaptersFromFlags(store, flags)
  const vm = new WorkflowVm({ image, store, adapters })
  const state = await vm.resume(runId)
  summarize(state)
  store.close()
}

async function cmdStatus(flags: Record<string, string | boolean>): Promise<void> {
  const state = str(flags.state)
  const runId = str(flags.run)
  if (!state) throw new Error('status requires --state <db>')
  const store = new SqliteStateStore(state)
  store.init()
  if (runId) {
    const run = store.loadRun(runId)
    if (!run) throw new Error(`run ${runId} not found`)
    summarize(run)
    console.log(`  receipts: ${store.listReceipts(runId).length}`)
  } else {
    for (const r of store.listRuns()) console.log(`${r.runId}  ${r.status.padEnd(10)} ${r.workflowId}  ${r.updatedAt}`)
  }
  const pending = store.pendingOutbox().length
  console.log(`pending outbox entries: ${pending}`)
  store.close()
}

async function cmdSync(flags: Record<string, string | boolean>): Promise<void> {
  const state = str(flags.state)
  const auditUrl = str(flags['audit-url'])
  if (!state || !auditUrl) throw new Error('sync requires --state <db> and --audit-url <url>')
  const store = new SqliteStateStore(state)
  store.init()
  const result = await syncOutbox(store, { baseUrl: auditUrl, token: str(flags['audit-token']) })
  console.log(`synced ${result.synced}/${result.attempted} (failed ${result.failed})`)
  for (const e of result.errors) console.error(`  ${e}`)
  store.close()
  if (result.failed > 0) process.exitCode = 1
}

const HELP = `wgvm — portable Workflow VM

Commands:
  keygen [--out key.json]
  build  (--input spec.json | --from-api URL --workflow-id ID [--token T]) --out image.wgvm [--keypair key.json] [--by name]
  verify image.wgvm [--require-signature] [--trusted pub.txt]
  run    image.wgvm [--inputs in.json] [--state run.db] [--run ID] [--require-signature]
                    [--iam-url U --iam-token T] [--llm-url ...] [--tool-url ...] [--git-url ...]
                    [--human-url ...] [--audit-url ...] [--sign-receipts priv.txt]
  resume image.wgvm --run ID --state run.db [online flags…]
  status --state run.db [--run ID]
  sync   --state run.db --audit-url URL [--audit-token T]
`

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv
  const { _, flags } = parseArgs(rest)
  switch (command) {
    case 'keygen': return cmdKeygen(flags)
    case 'build': return cmdBuild(flags)
    case 'verify': return cmdVerify(_, flags)
    case 'run': return cmdRun(_, flags)
    case 'resume': return cmdResume(_, flags)
    case 'status': return cmdStatus(flags)
    case 'sync': return cmdSync(flags)
    case 'help':
    case undefined:
    case '--help':
    case '-h':
      console.log(HELP)
      return
    default:
      console.error(`unknown command: ${command}\n`)
      console.log(HELP)
      process.exitCode = 2
  }
}

main().catch(err => {
  console.error(`error: ${(err as Error).message}`)
  process.exitCode = 1
})
