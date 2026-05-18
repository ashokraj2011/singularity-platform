/**
 * M42.5 — Express / TypeScript Repo Scanner (regex-based for V1).
 *
 * Walks .ts files looking for Express router declarations, Zod schemas
 * (z.object(...)), TypeScript interfaces, and service classes. Skips
 * dist/, node_modules/, tests (__tests__ + *.test.ts) for the
 * controller/model walk; tests get their own list.
 *
 * Regex is sufficient for the spec §11 Express baseline shape. A
 * ts-morph based scanner that handles unusual export styles is M42.5.1
 * follow-up.
 */
import { walkRepo, type SourceFile } from './common.js'
import type {
  RepoModel, RepoEndpoint, RepoModelEntry, RepoModelField,
  RepoService, RepoTest, RepoContract, RepoAuditEvent,
} from '../types.js'

// router.get('/foo', handler) | router.post("/foo", handler) | etc.
// We support both quote styles and an optional handler-name reference
// so we can record the function as the operationId.
const ROUTE_RE = /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"][\s\S]*?(?:async\s+)?(?:function\s*\w*\s*)?(?:\(|=>|\b([a-zA-Z_]\w*)\s*[,)])/g
// const fooSchema = z.object({ ... })   →  zod_schema entry
const ZOD_SCHEMA_RE = /(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*z\.object\s*\(\s*\{([\s\S]*?)\}\s*\)/g
// Inside a zod object body: `fieldName: z.string()` / `z.number().optional()`
const ZOD_FIELD_RE = /([a-zA-Z_]\w*)\s*:\s*z\.([a-zA-Z]+)\s*\(\s*\)\s*(\.optional\(\))?/g
// export interface Foo { fieldName: type; ... }
const INTERFACE_RE = /export\s+interface\s+([A-Z]\w+)\s*(?:extends\s+[^{]+)?\{([\s\S]*?)^}/gm
const TS_FIELD_RE = /^\s*([a-zA-Z_]\w*)\s*(\?)?\s*:\s*([A-Za-z_][\w<>|\[\] ]*)\s*;?\s*$/gm
// class FooService { ... }
const SERVICE_CLASS_RE = /export\s+class\s+([A-Z]\w+)Service\b/g
// Audit logger constant — same shape we emit from the Express
// template ("const EVENT_NAME = '...'").
const AUDIT_EVENT_RE = /(?:const|let)\s+EVENT_NAME\s*=\s*['"]([^'"]+)['"]/

export function scanExpress(repoPath: string): RepoModel {
  const tsFiles: SourceFile[] = []
  const otherFiles: SourceFile[] = []
  for (const f of walkRepo(repoPath, new Set(['.ts', '.tsx', '.json', '.yml', '.yaml']))) {
    if (f.relPath.endsWith('.ts') || f.relPath.endsWith('.tsx')) tsFiles.push(f)
    else otherFiles.push(f)
  }

  const controllers: RepoModel['controllers'] = []
  const models: RepoModelEntry[] = []
  const services: RepoService[] = []
  const tests: RepoTest[] = []
  const auditEvents: RepoAuditEvent[] = []
  const securityConfigFiles: string[] = []

  for (const f of tsFiles) {
    // Tests — *.test.ts, *.spec.ts, anything under __tests__/.
    const base = f.relPath.split('/').pop() ?? ''
    if (/__tests__\//.test(f.relPath) || /\.(test|spec)\.tsx?$/.test(base)) {
      const cls = /(?:describe|class)\s*[(\s]+['"]?([A-Z]\w+)/.exec(f.content)?.[1] ?? base
      tests.push({ className: cls, file: f.relPath })
      continue
    }

    // Routes — group by file as a single virtual "controller" since
    // Express routers don't have a class wrapper.
    const endpoints: RepoEndpoint[] = []
    ROUTE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ROUTE_RE.exec(f.content)) !== null) {
      endpoints.push({
        operationId: m[3] ?? deriveOpIdFromPath(m[1], m[2]),
        method: m[1].toUpperCase() as RepoEndpoint['method'],
        path: m[2],
        routerFile: f.relPath,
      })
    }
    if (endpoints.length > 0) {
      controllers.push({ className: 'router', file: f.relPath, endpoints })
    }

    // Zod schemas
    ZOD_SCHEMA_RE.lastIndex = 0
    let z: RegExpExecArray | null
    while ((z = ZOD_SCHEMA_RE.exec(f.content)) !== null) {
      const name = z[1]
      const body = z[2]
      const fields: RepoModelField[] = []
      ZOD_FIELD_RE.lastIndex = 0
      let zf: RegExpExecArray | null
      while ((zf = ZOD_FIELD_RE.exec(body)) !== null) {
        fields.push({ name: zf[1], type: zf[2], required: !zf[3] })
      }
      models.push({ name, file: f.relPath, kind: 'zod_schema', fields })
    }

    // TypeScript interfaces
    INTERFACE_RE.lastIndex = 0
    let i: RegExpExecArray | null
    while ((i = INTERFACE_RE.exec(f.content)) !== null) {
      const name = i[1]
      const body = i[2]
      const fields: RepoModelField[] = []
      TS_FIELD_RE.lastIndex = 0
      let tf: RegExpExecArray | null
      while ((tf = TS_FIELD_RE.exec(body)) !== null) {
        fields.push({ name: tf[1], type: tf[3].trim(), required: !tf[2] })
      }
      models.push({ name, file: f.relPath, kind: 'typescript_interface', fields })
    }

    // Services (export class FooService)
    SERVICE_CLASS_RE.lastIndex = 0
    let s: RegExpExecArray | null
    while ((s = SERVICE_CLASS_RE.exec(f.content)) !== null) {
      services.push({ className: `${s[1]}Service`, file: f.relPath, methods: [] })
    }

    const audit = AUDIT_EVENT_RE.exec(f.content)
    if (audit) auditEvents.push({ loggerClass: 'auditLogger', file: f.relPath, eventName: audit[1] })

    if (/helmet|csurf|express-rate-limit/.test(f.content) && /security|middleware/.test(f.relPath)) {
      securityConfigFiles.push(f.relPath)
    }
  }

  const contracts: RepoContract[] = []
  for (const f of otherFiles) {
    if (/openapi\.ya?ml$/.test(f.relPath)) contracts.push({ type: 'openapi', file: f.relPath })
  }

  return {
    application: {
      name: deriveAppName(repoPath),
      language: 'typescript',
      framework: 'express',
      repoPath,
    },
    controllers,
    models,
    services,
    tests,
    contracts,
    auditEvents,
    securityConfigFiles,
  }
}

function deriveOpIdFromPath(method: string, path: string): string {
  const segs = path.split('/').filter(Boolean).map(s => s.replace(/[^a-zA-Z0-9]/g, ''))
  return `${method}${segs.map(s => s[0].toUpperCase() + s.slice(1)).join('')}` || `${method}Handler`
}

function deriveAppName(repoPath: string): string {
  const segs = repoPath.split('/').filter(Boolean)
  return segs[segs.length - 1] ?? 'unknown-app'
}
