import express, { Router, type Request } from 'express'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import yaml from 'yaml'
import { prisma } from '../../lib/prisma'
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { requireTenantFromRequest, resolveTenantFromRequest, tenantIsolationStrict } from '../../lib/tenant-isolation'

export const codegenRouter: Router = Router()

codegenRouter.use(express.text({
  type: ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/plain'],
  limit: '2mb',
}))

const MAX_TAKE = 100
const DEFAULT_TAKE = 25
const MAX_FILE_BYTES = 1024 * 1024
const GENERATOR_VERSION = process.env.CODEGEN_GENERATOR_VERSION ?? 'workgraph-codegen-0.1.0'

interface CodegenSpecInput {
  specVersion?: string
  kind?: string
  metadata?: {
    id?: string
    name?: string
    description?: string
    version?: string
    [key: string]: unknown
  }
  application?: {
    name?: string
    language?: string
    framework?: string
    packageName?: string
    artifactId?: string
    buildTool?: string
    [key: string]: unknown
  }
  api?: {
    basePath?: string
    endpoints?: Array<Record<string, unknown>>
    [key: string]: unknown
  }
  models?: Array<Record<string, unknown>>
  dataSources?: Array<Record<string, unknown>>
  businessLogic?: Record<string, unknown>
  audit?: Record<string, unknown>
  [key: string]: unknown
}

interface ValidationIssue {
  path: string
  code: string
  message: string
}

interface ApplicationIr {
  meta: {
    specHash: string
    irHash: string
    generatorVersion: string
    templateVersion: string
  }
  application: Record<string, unknown>
  api: Record<string, unknown>
  endpoints: Array<Record<string, unknown>>
  models: Array<Record<string, unknown>>
  dataSources: Array<Record<string, unknown>>
  audit: Record<string, unknown> | null
}

interface GeneratedFile {
  path: string
  content: string
  fileType: string
  protected: boolean
  generatedBy: string
  contentHash: string
}

function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value))
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalizeValue)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalizeValue((value as Record<string, unknown>)[key])
  }
  return out
}

function sha256(input: string): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`
}

function parseBody(req: Request): { raw: CodegenSpecInput; rawText: string } {
  if (typeof req.body === 'string') {
    const text = req.body.trim()
    if (!text) throw new ValidationError('Empty body. Send a code generation spec as YAML or JSON.')
    try {
      return { raw: yaml.parse(text) as CodegenSpecInput, rawText: text }
    } catch (err) {
      throw new ValidationError(`Invalid YAML: ${(err as Error).message}`)
    }
  }
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new ValidationError('POST a JSON object with a `spec` field, a JSON spec object, or a YAML body.')
  }
  const body = req.body as Record<string, unknown>
  const raw = (body.spec && typeof body.spec === 'object') ? body.spec : body
  return { raw: raw as CodegenSpecInput, rawText: yaml.stringify(raw) }
}

function parseGenerateBody(req: Request): { raw: CodegenSpecInput; rawText: string; out?: string; workItemId?: string; actorId?: string } {
  const parsed = parseBody(req)
  const body = typeof req.body === 'object' && req.body ? req.body as Record<string, unknown> : {}
  return {
    ...parsed,
    out: typeof body.out === 'string' ? body.out : headerString(req, 'x-output-dir'),
    workItemId: typeof body.workItemId === 'string' ? body.workItemId : headerString(req, 'x-work-item-id'),
    actorId: typeof body.actorId === 'string' ? body.actorId : headerString(req, 'x-actor-id'),
  }
}

function validateSpec(raw: CodegenSpecInput): { valid: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[]; specHash?: string; canonicalJson?: string } {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  if (!raw || typeof raw !== 'object') {
    errors.push({ path: '$', code: 'invalid_type', message: 'Spec must be an object.' })
    return { valid: false, errors, warnings }
  }
  if (!raw.kind) errors.push({ path: 'kind', code: 'required', message: 'kind is required.' })
  if (!raw.metadata?.id) errors.push({ path: 'metadata.id', code: 'required', message: 'metadata.id is required.' })
  if (!raw.metadata?.version) errors.push({ path: 'metadata.version', code: 'required', message: 'metadata.version is required.' })
  if (!raw.application?.framework) errors.push({ path: 'application.framework', code: 'required', message: 'application.framework is required.' })
  if (!raw.application?.language) warnings.push({ path: 'application.language', code: 'defaulted', message: 'application.language was not provided; the generator will infer it from framework.' })
  if (!Array.isArray(raw.api?.endpoints) || raw.api!.endpoints!.length === 0) {
    errors.push({ path: 'api.endpoints', code: 'required', message: 'At least one endpoint is required.' })
  }
  const canonicalJson = canonicalize(raw)
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    specHash: sha256(canonicalJson),
    canonicalJson,
  }
}

function buildIr(raw: CodegenSpecInput, specHash: string): ApplicationIr {
  const framework = String(raw.application?.framework ?? 'generic')
  const templateVersion = `${framework}-template-0.1.0`
  const endpoints = (raw.api?.endpoints ?? []).map((endpoint) => ({
    ...endpoint,
    operationId: String(endpoint.operationId ?? endpoint.name ?? 'operation'),
    businessLogicCoverage: raw.businessLogic ? 'FULL' : 'PARTIAL',
  }))
  const base: ApplicationIr = {
    meta: {
      specHash,
      irHash: '',
      generatorVersion: GENERATOR_VERSION,
      templateVersion,
    },
    application: {
      ...(raw.application ?? {}),
      name: raw.application?.name ?? raw.metadata?.name ?? raw.metadata?.id ?? 'GeneratedService',
      language: raw.application?.language ?? inferLanguage(framework),
      framework,
    },
    api: raw.api ?? {},
    endpoints,
    models: raw.models ?? [],
    dataSources: raw.dataSources ?? [],
    audit: raw.audit ?? null,
  }
  return { ...base, meta: { ...base.meta, irHash: sha256(canonicalize(base)) } }
}

function inferLanguage(framework: string): string {
  if (framework === 'spring-boot') return 'java'
  if (framework === 'fastapi') return 'python'
  if (framework === 'express') return 'typescript'
  return 'unknown'
}

function specIdentity(raw: CodegenSpecInput): { specName: string; version: string; kind: string } {
  return {
    specName: String(raw.metadata?.id ?? 'generated-service'),
    version: String(raw.metadata?.version ?? '1.0.0'),
    kind: String(raw.kind ?? 'service'),
  }
}

async function assertFlag(key: string): Promise<void> {
  const flag = await prisma.featureFlag.findUnique({ where: { key } }).catch(() => null)
  if (flag && !flag.enabled) {
    throw new AppError(`Feature flag ${key} is disabled.`, 'FEATURE_DISABLED', 503, { flag: key })
  }
}

async function upsertSpec(args: {
  raw: CodegenSpecInput
  rawText: string
  canonicalJson: string
  specHash: string
  ir: ApplicationIr
  actorId?: string | null
  workItemId?: string | null
  tenantId?: string | null
}) {
  const identity = specIdentity(args.raw)
  const existing = await prisma.codegenSpec.findUnique({
    where: { specName_version: { specName: identity.specName, version: identity.version } },
  })
  if (existing && existing.specHash !== args.specHash) {
    throw new ConflictError(`Spec '${identity.specName}@${identity.version}' already exists with a different hash. Bump metadata.version.`)
  }
  return existing
    ? prisma.codegenSpec.update({
        where: { id: existing.id },
        data: {
          irJson: args.ir as any,
          irHash: args.ir.meta.irHash,
          workItemId: args.workItemId ?? existing.workItemId,
          tenantId: args.tenantId ?? existing.tenantId,
        },
      })
    : prisma.codegenSpec.create({
        data: {
          specName: identity.specName,
          version: identity.version,
          kind: identity.kind,
          state: 'DRAFT',
          yaml: args.rawText,
          canonicalJson: JSON.parse(args.canonicalJson),
          specHash: args.specHash,
          irJson: args.ir as any,
          irHash: args.ir.meta.irHash,
          workItemId: args.workItemId ?? null,
          createdById: args.actorId ?? null,
          tenantId: args.tenantId ?? null,
        },
      })
}

async function transitionSpec(specId: string, toState: string, actorId: string | null | undefined, reason: string): Promise<void> {
  const spec = await prisma.codegenSpec.findUnique({ where: { id: specId } })
  if (!spec) throw new NotFoundError('CodegenSpec', specId)
  if (spec.state === toState) return
  await prisma.codegenSpec.update({ where: { id: specId }, data: { state: toState } })
  await prisma.codegenSpecLifecycleEvent.create({
    data: {
      specId,
      fromState: spec.state,
      toState,
      actorId: actorId ?? null,
      reason,
    },
  })
}

async function freezeSpec(specId: string, actorId?: string | null): Promise<void> {
  const spec = await prisma.codegenSpec.findUnique({ where: { id: specId } })
  if (!spec) throw new NotFoundError('CodegenSpec', specId)
  if (spec.state === 'DRAFT') {
    await transitionSpec(specId, 'VALIDATED', actorId, 'validate')
    await transitionSpec(specId, 'POLICY_APPROVED', actorId, 'policy_approved')
    await transitionSpec(specId, 'FROZEN', actorId, 'freeze')
  } else if (spec.state === 'VALIDATED') {
    await transitionSpec(specId, 'POLICY_APPROVED', actorId, 'policy_approved')
    await transitionSpec(specId, 'FROZEN', actorId, 'freeze')
  } else if (spec.state === 'POLICY_APPROVED') {
    await transitionSpec(specId, 'FROZEN', actorId, 'freeze')
  }
}

function generateFiles(ir: ApplicationIr, raw: CodegenSpecInput): GeneratedFile[] {
  const framework = String(ir.application.framework ?? 'generic')
  const files = framework === 'fastapi'
    ? fastApiFiles(ir, raw)
    : framework === 'spring-boot'
      ? springBootFiles(ir, raw)
      : expressFiles(ir, raw)
  return files.map((file) => ({
    ...file,
    generatedBy: `${framework}-template-0.1.0`,
    contentHash: sha256(file.content),
  }))
}

function expressFiles(ir: ApplicationIr, raw: CodegenSpecInput): Omit<GeneratedFile, 'generatedBy' | 'contentHash'>[] {
  const appName = String(ir.application.name ?? 'GeneratedService')
  const basePath = String((raw.api?.basePath ?? '/api'))
  const endpoints = ir.endpoints
  const models = ir.models
  return [
    {
      path: 'package.json',
      fileType: 'config',
      protected: true,
      content: JSON.stringify({
        name: String(raw.application?.artifactId ?? appName).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
        version: raw.metadata?.version ?? '1.0.0',
        type: 'module',
        scripts: { dev: 'tsx src/server.ts', test: 'node --test' },
        dependencies: { express: '^4.18.3' },
        devDependencies: { tsx: '^4.19.0', typescript: '^5.5.0' },
      }, null, 2) + '\n',
    },
    {
      path: 'README.md',
      fileType: 'doc',
      protected: false,
      content: `# ${raw.metadata?.name ?? appName}\n\nGenerated by Workgraph Code Generation.\n\nBase path: \`${basePath}\`\n\n`,
    },
    {
      path: 'src/server.ts',
      fileType: 'source',
      protected: true,
      content: `import express from "express";\nimport { router } from "./routes.js";\n\nconst app = express();\napp.use(express.json());\napp.use("${basePath}", router);\n\nconst port = Number(process.env.PORT ?? 3000);\napp.listen(port, () => console.log("${appName} listening on " + port));\n`,
    },
    {
      path: 'src/routes.ts',
      fileType: 'source',
      protected: false,
      content: `import { Router } from "express";\n\nexport const router = Router();\n\n${endpoints.map((endpoint) => {
        const method = String(endpoint.method ?? 'GET').toLowerCase()
        const routePath = String(endpoint.path ?? '/')
        const operationId = String(endpoint.operationId ?? 'operation')
        return `router.${method}("${routePath.replace(/\{([^}]+)\}/g, ':$1')}", async (_req, res) => {\n  // <llm-editable region="business-logic" operation="${operationId}">\n  res.json({ operationId: "${operationId}", status: "generated" });\n  // </llm-editable>\n});`
      }).join('\n\n')}\n`,
    },
    {
      path: 'src/models.ts',
      fileType: 'source',
      protected: false,
      content: models.map((model) => {
        const fields = Array.isArray(model.fields) ? model.fields : []
        return `export interface ${String(model.name ?? 'GeneratedModel')} {\n${fields.map((field) => {
          const f = field as Record<string, unknown>
          return `  ${String(f.name ?? 'field')}${f.required === false ? '?' : ''}: ${tsType(String(f.type ?? 'string'))};`
        }).join('\n')}\n}`
      }).join('\n\n') + '\n',
    },
    {
      path: 'openapi.yml',
      fileType: 'contract',
      protected: true,
      content: yaml.stringify({
        openapi: '3.1.0',
        info: { title: raw.metadata?.name ?? appName, version: raw.metadata?.version ?? '1.0.0' },
        paths: Object.fromEntries(endpoints.map((endpoint) => [
          `${basePath}${String(endpoint.path ?? '/')}`,
          { [String(endpoint.method ?? 'GET').toLowerCase()]: { operationId: endpoint.operationId, responses: { '200': { description: 'OK' } } } },
        ])),
      }),
    },
  ]
}

function fastApiFiles(ir: ApplicationIr, raw: CodegenSpecInput): Omit<GeneratedFile, 'generatedBy' | 'contentHash'>[] {
  const appName = String(ir.application.name ?? 'GeneratedService')
  return [
    { path: 'README.md', fileType: 'doc', protected: false, content: `# ${raw.metadata?.name ?? appName}\n\nGenerated by Workgraph Code Generation.\n` },
    {
      path: 'main.py',
      fileType: 'source',
      protected: false,
      content: `from fastapi import FastAPI\n\napp = FastAPI(title="${raw.metadata?.name ?? appName}")\n\n${ir.endpoints.map((endpoint) => {
        const operationId = String(endpoint.operationId ?? 'operation')
        const routePath = String(endpoint.path ?? '/').replace(/\{([^}]+)\}/g, '{$1}')
        return `@app.${String(endpoint.method ?? 'GET').toLowerCase()}("${routePath}")\ndef ${operationId}():\n    # <llm-editable region="business-logic" operation="${operationId}">\n    return {"operationId": "${operationId}", "status": "generated"}\n    # </llm-editable>\n`
      }).join('\n')}`,
    },
    { path: 'pyproject.toml', fileType: 'config', protected: true, content: `[project]\nname = "${String(raw.application?.artifactId ?? appName).toLowerCase()}"\nversion = "${raw.metadata?.version ?? '1.0.0'}"\ndependencies = ["fastapi"]\n` },
  ]
}

function springBootFiles(ir: ApplicationIr, raw: CodegenSpecInput): Omit<GeneratedFile, 'generatedBy' | 'contentHash'>[] {
  const packageName = String(raw.application?.packageName ?? 'com.company.generated')
  const appName = String(ir.application.name ?? 'GeneratedService')
  return [
    { path: 'README.md', fileType: 'doc', protected: false, content: `# ${raw.metadata?.name ?? appName}\n\nGenerated by Workgraph Code Generation.\n` },
    {
      path: `src/main/java/${packageName.replace(/\./g, '/')}/${appName}.java`,
      fileType: 'source',
      protected: false,
      content: `package ${packageName};\n\npublic class ${appName} {\n${ir.endpoints.map((endpoint) => `  // <llm-editable region="business-logic" operation="${String(endpoint.operationId ?? 'operation')}">\n  public String ${String(endpoint.operationId ?? 'operation')}() { return "generated"; }\n  // </llm-editable>`).join('\n\n')}\n}\n`,
    },
    { path: 'pom.xml', fileType: 'config', protected: true, content: `<project><modelVersion>4.0.0</modelVersion><groupId>${raw.application?.groupId ?? 'com.company'}</groupId><artifactId>${raw.application?.artifactId ?? appName}</artifactId><version>${raw.metadata?.version ?? '1.0.0'}</version></project>\n` },
  ]
}

function tsType(type: string): string {
  if (['boolean', 'bool'].includes(type)) return 'boolean'
  if (['integer', 'number', 'float', 'double'].includes(type)) return 'number'
  if (['datetime', 'date', 'string'].includes(type)) return 'string'
  return 'unknown'
}

function writeFilesBestEffort(outDir: string | undefined, files: GeneratedFile[]): void {
  if (!outDir) return
  try {
    const base = resolve(outDir)
    for (const file of files) {
      if (file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some((part) => part === '..')) continue
      const abs = resolve(base, file.path)
      if (!(abs === base || abs.startsWith(base + sep))) continue
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, file.content, 'utf8')
    }
  } catch {
    // Artifacts are persisted in DB, so filesystem writes are a compatibility
    // convenience only.
  }
}

async function createRunReceipt(args: {
  specId: string
  specName: string
  specVersion: string
  specHash: string
  ir: ApplicationIr
  actorId?: string | null
  workItemId?: string | null
  tenantId?: string | null
  generatedArtifacts?: GeneratedFile[]
  outputPath?: string | null
}) {
  const artifacts = args.generatedArtifacts ?? []
  const run = await prisma.codegenRun.create({
    data: {
      specId: args.specId,
      irHash: args.ir.meta.irHash,
      templateVersion: args.ir.meta.templateVersion,
      generatorVersion: args.ir.meta.generatorVersion,
      status: artifacts.length > 0 ? 'GENERATED' : 'STARTED',
      outputPath: args.outputPath ?? null,
      completedAt: artifacts.length > 0 ? new Date() : null,
      tenantId: args.tenantId ?? null,
    },
  })
  const body = {
    receiptVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    spec: { id: args.specId, name: args.specName, version: args.specVersion, hash: args.specHash },
    ir: {
      hash: args.ir.meta.irHash,
      application: args.ir.application,
      endpointCount: args.ir.endpoints.length,
      modelCount: args.ir.models.length,
      dataSourceCount: args.ir.dataSources.length,
      coverage: args.ir.endpoints.map((endpoint) => ({
        operationId: endpoint.operationId,
        coverage: endpoint.businessLogicCoverage,
      })),
    },
    generator: { version: args.ir.meta.generatorVersion, templateVersion: args.ir.meta.templateVersion },
    generatedArtifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      contentHash: artifact.contentHash,
      protected: artifact.protected,
    })),
    workItemId: args.workItemId ?? null,
  }
  const receiptHash = sha256(canonicalize(body))
  const receipt = await prisma.codegenReceipt.create({
    data: {
      runId: run.id,
      receiptJson: body as any,
      receiptHash,
    },
  })
  if (artifacts.length > 0) {
    await prisma.codegenArtifact.createMany({
      data: artifacts.map((artifact) => ({
        runId: run.id,
        path: artifact.path,
        contentHash: artifact.contentHash,
        fileType: artifact.fileType,
        generatedBy: artifact.generatedBy,
        protected: artifact.protected,
        content: artifact.content,
        sizeBytes: Buffer.byteLength(artifact.content, 'utf8'),
      })),
      skipDuplicates: true,
    })
  }
  await prisma.receipt.create({
    data: {
      receiptType: 'code_generation',
      entityType: 'codegen_run',
      entityId: run.id,
      content: body as any,
    },
  }).catch(() => undefined)
  return { run, receipt, receiptHash, body }
}

function tenantIdFor(req: Request): string | undefined {
  return tenantIsolationStrict()
    ? requireTenantFromRequest(req, 'code generation')
    : resolveTenantFromRequest(req)
}

function tenantWhere(req: Request): { tenantId?: string | null } {
  const tenantId = tenantIdFor(req)
  return tenantId ? { tenantId } : {}
}

function runListShape(run: any) {
  return {
    id: run.id,
    specId: run.specId,
    specName: run.spec?.specName,
    specVersion: run.spec?.version,
    specKind: run.spec?.kind,
    mode: run.mode,
    status: run.status,
    templateVersion: run.templateVersion,
    generatorVersion: run.generatorVersion,
    outputPath: run.outputPath,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    brownfieldPlanId: run.brownfieldPlanId,
  }
}

codegenRouter.get('/runs', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const take = clampInt(req.query.take, DEFAULT_TAKE, 1, MAX_TAKE)
    const skip = clampInt(req.query.skip, 0, 0, 10000)
    const where: Record<string, unknown> = tenantWhere(req)
    if (typeof req.query.status === 'string') where.status = req.query.status
    if (typeof req.query.mode === 'string') where.mode = req.query.mode
    if (typeof req.query.specId === 'string') where.specId = req.query.specId
    const [total, items] = await Promise.all([
      prisma.codegenRun.count({ where }),
      prisma.codegenRun.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }],
        take,
        skip,
        include: { spec: { select: { specName: true, version: true, kind: true } } },
      }),
    ])
    res.json({ total, take, skip, items: items.map(runListShape) })
  } catch (err) { next(err) }
})

codegenRouter.post('/spec/validate', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.greenfield.enabled')
    const { raw } = parseBody(req)
    const validation = validateSpec(raw)
    if (!validation.valid) return res.status(400).json({ valid: false, errors: validation.errors, warnings: validation.warnings })
    const ir = buildIr(raw, validation.specHash!)
    res.json({ valid: true, errors: [], warnings: validation.warnings, specHash: validation.specHash, irHash: ir.meta.irHash, ir })
  } catch (err) { next(err) }
})

codegenRouter.post('/spec/freeze', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.greenfield.enabled')
    const parsed = parseGenerateBody(req)
    const validation = validateSpec(parsed.raw)
    if (!validation.valid) return res.status(400).json({ code: 'SPEC_INVALID', errors: validation.errors })
    const ir = buildIr(parsed.raw, validation.specHash!)
    const tenantId = tenantIdFor(req)
    const actorId = parsed.actorId ?? req.user?.userId
    const spec = await upsertSpec({
      raw: parsed.raw,
      rawText: parsed.rawText,
      canonicalJson: validation.canonicalJson!,
      specHash: validation.specHash!,
      ir,
      actorId,
      workItemId: parsed.workItemId,
      tenantId,
    })
    await freezeSpec(spec.id, actorId)
    const persisted = await createRunReceipt({
      specId: spec.id,
      specName: spec.specName,
      specVersion: spec.version,
      specHash: spec.specHash,
      ir,
      actorId,
      workItemId: parsed.workItemId,
      tenantId,
    })
    res.json({
      specId: spec.id,
      specName: spec.specName,
      version: spec.version,
      specHash: spec.specHash,
      irHash: ir.meta.irHash,
      state: 'FROZEN',
      runId: persisted.run.id,
      receiptHash: persisted.receiptHash,
    })
  } catch (err) { next(err) }
})

codegenRouter.post('/generate', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.greenfield.enabled')
    const parsed = parseGenerateBody(req)
    const validation = validateSpec(parsed.raw)
    if (!validation.valid) return res.status(400).json({ code: 'SPEC_INVALID', errors: validation.errors })
    const ir = buildIr(parsed.raw, validation.specHash!)
    const tenantId = tenantIdFor(req)
    const actorId = parsed.actorId ?? req.user?.userId
    const spec = await upsertSpec({
      raw: parsed.raw,
      rawText: parsed.rawText,
      canonicalJson: validation.canonicalJson!,
      specHash: validation.specHash!,
      ir,
      actorId,
      workItemId: parsed.workItemId,
      tenantId,
    })
    await freezeSpec(spec.id, actorId)
    const files = generateFiles(ir, parsed.raw)
    const outDir = parsed.out && parsed.out.trim() ? resolve(parsed.out) : `/workspace/codegen/${spec.id}`
    writeFilesBestEffort(outDir, files)
    const persisted = await createRunReceipt({
      specId: spec.id,
      specName: spec.specName,
      specVersion: spec.version,
      specHash: spec.specHash,
      ir,
      actorId,
      workItemId: parsed.workItemId,
      tenantId,
      generatedArtifacts: files,
      outputPath: outDir,
    })
    res.json({
      specId: spec.id,
      runId: persisted.run.id,
      receiptHash: persisted.receiptHash,
      specHash: spec.specHash,
      irHash: ir.meta.irHash,
      templateVersion: ir.meta.templateVersion,
      outputPath: outDir,
      generatedFileCount: files.length,
      manifestPath: `${outDir}/.singularity-codegen-manifest.json`,
      coverage: ir.endpoints.map((endpoint) => ({
        operationId: endpoint.operationId,
        coverage: endpoint.businessLogicCoverage,
        willEmitEditableRegion: endpoint.businessLogicCoverage !== 'FULL',
      })),
    })
  } catch (err) { next(err) }
})

codegenRouter.get('/runs/:runId', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const run = await prisma.codegenRun.findFirst({
      where: { id: req.params.runId, ...tenantWhere(req) },
      include: {
        spec: { select: { specName: true, version: true, kind: true, specHash: true, irHash: true } },
        receipt: { select: { id: true, receiptHash: true, createdAt: true } },
        changePlan: { select: { id: true, status: true, planHash: true, repoModelId: true } },
      },
    })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const [artifactCount, gapCount, openGapCount, taskCount, openTaskCount] = await Promise.all([
      prisma.codegenArtifact.count({ where: { runId: run.id } }),
      prisma.codegenGap.count({ where: { runId: run.id } }),
      prisma.codegenGap.count({ where: { runId: run.id, resolved: false } }),
      prisma.codegenLlmPatchTask.count({ where: { runId: run.id } }),
      prisma.codegenLlmPatchTask.count({ where: { runId: run.id, status: { in: ['PENDING', 'DISPATCHED'] } } }),
    ])
    res.json({
      ...run,
      counts: { artifacts: artifactCount, gaps: gapCount, openGaps: openGapCount, llmTasks: taskCount, openLlmTasks: openTaskCount },
    })
  } catch (err) { next(err) }
})

codegenRouter.get('/runs/:runId/artifacts', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const run = await prisma.codegenRun.findFirst({ where: { id: req.params.runId, ...tenantWhere(req) } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const items = await prisma.codegenArtifact.findMany({
      where: { runId: run.id },
      orderBy: [{ path: 'asc' }],
      select: { id: true, path: true, contentHash: true, fileType: true, generatedBy: true, protected: true, sizeBytes: true, createdAt: true },
    })
    res.json({ runId: run.id, outputPath: run.outputPath, items })
  } catch (err) { next(err) }
})

codegenRouter.get('/runs/:runId/file', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const run = await prisma.codegenRun.findFirst({ where: { id: req.params.runId, ...tenantWhere(req) } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const rel = typeof req.query.path === 'string' ? req.query.path : ''
    if (!rel) throw new ValidationError('Missing ?path=<relative-file-path>.')
    if (rel.startsWith('/') || rel.includes('\\') || rel.split(/[/\\]/).some((part) => part === '..')) {
      throw new ValidationError(`Invalid path '${rel}'.`)
    }
    const artifact = await prisma.codegenArtifact.findUnique({
      where: { runId_path: { runId: run.id, path: rel } },
    })
    if (artifact?.content !== null && artifact?.content !== undefined) {
      return res.json({ path: rel, bytes: Buffer.byteLength(artifact.content, 'utf8'), content: artifact.content, modifiedAt: artifact.createdAt })
    }
    if (!run.outputPath) throw new ValidationError('Run has no outputPath and the artifact has no stored content.')
    const base = resolve(run.outputPath)
    const abs = resolve(base, rel)
    if (!(abs === base || abs.startsWith(base + sep))) throw new ValidationError(`Path '${rel}' escapes the run output directory.`)
    if (!existsSync(abs)) return res.status(404).json({ code: 'NOT_FOUND', message: `File '${rel}' not found.` })
    const stat = statSync(abs)
    if (!stat.isFile()) return res.status(400).json({ code: 'NOT_A_FILE', message: `Path '${rel}' is not a file.` })
    if (stat.size > MAX_FILE_BYTES) {
      return res.status(413).json({ code: 'FILE_TOO_LARGE', message: `File '${rel}' is ${stat.size} bytes; viewer limit is ${MAX_FILE_BYTES}.`, size: stat.size, limit: MAX_FILE_BYTES })
    }
    res.json({ path: rel, bytes: stat.size, content: readFileSync(abs, 'utf8'), modifiedAt: stat.mtime })
  } catch (err) { next(err) }
})

codegenRouter.get('/runs/:runId/gaps', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const run = await prisma.codegenRun.findFirst({ where: { id: req.params.runId, ...tenantWhere(req) }, select: { id: true } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const items = await prisma.codegenGap.findMany({
      where: { runId: run.id },
      orderBy: [{ resolved: 'asc' }, { severity: 'desc' }, { createdAt: 'asc' }],
    })
    res.json({ runId: run.id, items })
  } catch (err) { next(err) }
})

codegenRouter.post('/runs/:runId/detect-gaps', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.greenfield.enabled')
    const run = await prisma.codegenRun.findFirst({ where: { id: req.params.runId, ...tenantWhere(req) }, include: { artifacts: true } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    await prisma.codegenGap.deleteMany({ where: { runId: run.id, resolved: false } })
    const detected = run.artifacts.length > 0 ? [] : [{
      gapType: 'UNRESOLVED_TEMPLATE_VAR',
      severity: 'medium',
      description: 'No generated artifacts were present for this run.',
      recommendedResolution: 'Generate the project before running gap detection.',
      llmEligible: false,
    }]
    if (detected.length) await prisma.codegenGap.createMany({ data: detected.map((gap) => ({ ...gap, runId: run.id })) })
    if (detected.length > 0) await prisma.codegenRun.update({ where: { id: run.id }, data: { status: 'GAPS_DETECTED' } })
    res.json({ runId: run.id, gapCount: detected.length, gaps: detected })
  } catch (err) { next(err) }
})

codegenRouter.post('/runs/:runId/verify', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.greenfield.enabled')
    const run = await prisma.codegenRun.findFirst({ where: { id: req.params.runId, ...tenantWhere(req) }, include: { artifacts: true } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const result = {
      status: run.artifacts.length > 0 ? 'PASSED' : 'SKIPPED',
      checks: [{ name: 'artifact-index', status: run.artifacts.length > 0 ? 'PASSED' : 'SKIPPED', details: { artifactCount: run.artifacts.length } }],
    }
    const persisted = await prisma.codegenVerification.create({
      data: { runId: run.id, status: result.status, result: result as any },
    })
    if (result.status === 'PASSED') await prisma.codegenRun.update({ where: { id: run.id }, data: { status: 'VERIFIED', completedAt: new Date() } })
    res.json({ id: persisted.id, ...result })
  } catch (err) { next(err) }
})

codegenRouter.get('/runs/:runId/verification', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const run = await prisma.codegenRun.findFirst({ where: { id: req.params.runId, ...tenantWhere(req) }, select: { id: true } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const row = await prisma.codegenVerification.findFirst({ where: { runId: run.id }, orderBy: { createdAt: 'desc' } })
    if (!row) throw new NotFoundError('CodegenVerification', req.params.runId)
    res.json({ id: row.id, status: row.status, createdAt: row.createdAt, ...(row.result as object) })
  } catch (err) { next(err) }
})

codegenRouter.get('/runs/:runId/receipt', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const run = await prisma.codegenRun.findFirst({ where: { id: req.params.runId, ...tenantWhere(req) }, select: { id: true } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const receipt = await prisma.codegenReceipt.findFirst({ where: { runId: run.id } })
    if (!receipt) throw new NotFoundError('CodegenReceipt', req.params.runId)
    res.json(receipt)
  } catch (err) { next(err) }
})

codegenRouter.get('/specs/:id', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const spec = await prisma.codegenSpec.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } })
    if (!spec) throw new NotFoundError('CodegenSpec', req.params.id)
    res.json(spec)
  } catch (err) { next(err) }
})

codegenRouter.get('/specs/:id/history', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const spec = await prisma.codegenSpec.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } })
    if (!spec) throw new NotFoundError('CodegenSpec', req.params.id)
    const items = await prisma.codegenSpecLifecycleEvent.findMany({ where: { specId: spec.id }, orderBy: { occurredAt: 'asc' } })
    res.json({ items })
  } catch (err) { next(err) }
})

codegenRouter.get('/repos', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const items = await prisma.codegenRepoModel.findMany({
      where: tenantWhere(req),
      orderBy: [{ scannedAt: 'desc' }],
      take: 50,
      select: { id: true, repoPath: true, language: true, framework: true, modelHash: true, scannedAt: true },
    })
    res.json({ items })
  } catch (err) { next(err) }
})

codegenRouter.post('/repos/scan', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.brownfield.enabled')
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
    const repoPath = typeof body.repoPath === 'string' ? body.repoPath : undefined
    if (!repoPath) throw new ValidationError('Missing repoPath in request body.')
    const framework = typeof body.framework === 'string' ? body.framework : 'unknown'
    const model = { application: { framework, language: inferLanguage(framework) }, repoPath, discoveredAt: new Date().toISOString(), files: [] }
    const modelHash = sha256(canonicalize(model))
    const row = await prisma.codegenRepoModel.create({
      data: {
        repoPath,
        language: inferLanguage(framework),
        framework,
        modelJson: model as any,
        modelHash,
        scannedById: req.user?.userId ?? null,
        tenantId: tenantIdFor(req) ?? null,
      },
    })
    res.json({ repoModelId: row.id, modelHash, summary: { application: model.application, controllers: 0, endpoints: 0, models: 0, services: 0, tests: 0, contracts: 0, auditEvents: 0, securityConfigFiles: 0 }, model })
  } catch (err) { next(err) }
})

codegenRouter.get('/repos/:id', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const row = await prisma.codegenRepoModel.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } })
    if (!row) throw new NotFoundError('CodegenRepoModel', req.params.id)
    res.json(row)
  } catch (err) { next(err) }
})

codegenRouter.get('/change-plans', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const repoModelId = typeof req.query.repoModelId === 'string' ? req.query.repoModelId : undefined
    const items = await prisma.codegenChangePlan.findMany({
      where: { ...(repoModelId ? { repoModelId } : {}), ...tenantWhere(req) },
      orderBy: [{ createdAt: 'desc' }],
      take: 50,
      select: { id: true, repoModelId: true, planHash: true, enhancementSpecHash: true, status: true, createdAt: true, appliedAt: true },
    })
    res.json({ items })
  } catch (err) { next(err) }
})

codegenRouter.post('/enhancements/plan', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.brownfield.enabled')
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
    const repoModelId = typeof body.repoModelId === 'string' ? body.repoModelId : undefined
    if (!repoModelId) throw new ValidationError('Missing repoModelId.')
    const repo = await prisma.codegenRepoModel.findFirst({ where: { id: repoModelId, ...tenantWhere(req) } })
    if (!repo) throw new NotFoundError('CodegenRepoModel', repoModelId)
    const enhancement = (body.enhancement && typeof body.enhancement === 'object') ? body.enhancement : {}
    const enhancementSpecHash = sha256(canonicalize(enhancement))
    const plan = { operations: [], status: 'PROPOSED', note: 'Workgraph captured the plan; deterministic recipe execution is handled by workflow stages.' }
    const planHash = sha256(canonicalize(plan))
    const row = await prisma.codegenChangePlan.create({
      data: { repoModelId: repo.id, enhancementSpecJson: enhancement as any, enhancementSpecHash, planJson: plan as any, planHash, tenantId: tenantIdFor(req) ?? null },
    })
    res.json({ changePlanId: row.id, planHash, enhancementSpecHash, repoModelHash: repo.modelHash, impact: { affectedFiles: [], risk: 'low' }, plan })
  } catch (err) { next(err) }
})

codegenRouter.get('/change-plans/:id', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const row = await prisma.codegenChangePlan.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } })
    if (!row) throw new NotFoundError('CodegenChangePlan', req.params.id)
    res.json(row)
  } catch (err) { next(err) }
})

codegenRouter.post('/enhancements/apply', async (_req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.brownfield.enabled')
    res.status(501).json({
      code: 'WORKFLOW_OWNED_BROWNFIELD_APPLY',
      message: 'Brownfield apply is now orchestrated as a Workgraph workflow stage. Persist a change plan, then run the code-generation workflow.',
    })
  } catch (err) { next(err) }
})

codegenRouter.post('/runs/:runId/llm-tasks', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.llm_patch.enabled')
    const run = await prisma.codegenRun.findFirst({ where: { id: req.params.runId, ...tenantWhere(req) }, select: { id: true } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    res.json({ runId: run.id, created: 0, tasks: [] })
  } catch (err) { next(err) }
})

codegenRouter.get('/runs/:runId/llm-tasks', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const run = await prisma.codegenRun.findFirst({ where: { id: req.params.runId, ...tenantWhere(req) }, select: { id: true } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const items = await prisma.codegenLlmPatchTask.findMany({ where: { runId: run.id }, orderBy: [{ createdAt: 'asc' }] })
    res.json({ runId: run.id, items })
  } catch (err) { next(err) }
})

codegenRouter.get('/llm-tasks/:taskId', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    const task = await prisma.codegenLlmPatchTask.findUnique({ where: { id: req.params.taskId } })
    if (!task) throw new NotFoundError('CodegenLlmPatchTask', req.params.taskId)
    res.json(task)
  } catch (err) { next(err) }
})

codegenRouter.post('/llm-tasks/:taskId/dispatch', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.llm_patch.enabled')
    const task = await prisma.codegenLlmPatchTask.findUnique({ where: { id: req.params.taskId } })
    if (!task) throw new NotFoundError('CodegenLlmPatchTask', req.params.taskId)
    res.status(501).json({ taskId: task.id, status: 'WORKFLOW_OWNED', error: 'Patch dispatch now routes through Workgraph agent/tool runs.' })
  } catch (err) { next(err) }
})

codegenRouter.post('/llm-tasks/:taskId/apply-patch', async (req, res, next) => {
  try {
    await assertFlag('code_foundry.enabled')
    await assertFlag('code_foundry.llm_patch.enabled')
    const task = await prisma.codegenLlmPatchTask.findUnique({ where: { id: req.params.taskId } })
    if (!task) throw new NotFoundError('CodegenLlmPatchTask', req.params.taskId)
    res.status(501).json({ taskId: task.id, status: 'WORKFLOW_OWNED', reason: 'Patch application now routes through governed Workgraph execution.' })
  } catch (err) { next(err) }
})

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'string') return fallback
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function headerString(req: Request, name: string): string | undefined {
  const v = req.headers[name]
  if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}
