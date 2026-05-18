/**
 * M42.5 — FastAPI Repo Scanner (regex-based for V1).
 *
 * Walks .py files looking for FastAPI router declarations, pydantic
 * BaseModel subclasses, and basic service classes. Skips
 * tests/__pycache__/.venv via common walker.
 */
import { walkRepo, type SourceFile } from './common.js'
import type {
  RepoModel, RepoEndpoint, RepoModelEntry, RepoModelField, RepoService,
  RepoTest, RepoContract, RepoAuditEvent,
} from '../types.js'

const ROUTE_RE = /@router\.(get|post|put|patch|delete)\s*\(\s*"([^"]+)"[\s\S]*?\)\s*def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([\w\[\]]+)\s*)?:/g
const PYDANTIC_CLASS_RE = /class\s+([A-Z]\w+)\s*\(\s*BaseModel(?:\s*,\s*[^)]+)?\s*\)\s*:\s*([\s\S]+?)(?=^\S|\Z)/gm
const PY_FIELD_RE = /^\s+(\w+)\s*:\s*([A-Za-z_][\w\[\]\|]*)(?:\s*=\s*(?:Field\s*\(|None|[^#\n]+))?/gm
const SERVICE_CLASS_RE = /class\s+([A-Z]\w+)Service\s*[:\(]/g
const AUDIT_LOGGER_RE = /_EVENT_NAME\s*=\s*"([^"]+)"/

export function scanFastApi(repoPath: string): RepoModel {
  const pyFiles: SourceFile[] = []
  const otherFiles: SourceFile[] = []
  for (const f of walkRepo(repoPath, new Set(['.py', '.yml', '.yaml', '.toml']))) {
    if (f.relPath.endsWith('.py')) pyFiles.push(f)
    else otherFiles.push(f)
  }

  const controllers: RepoModel['controllers'] = []
  const models: RepoModelEntry[] = []
  const services: RepoService[] = []
  const tests: RepoTest[] = []
  const auditEvents: RepoAuditEvent[] = []
  const securityConfigFiles: string[] = []

  for (const f of pyFiles) {
    if (/(?:^|\/)tests?\//.test(f.relPath) || /test_/.test(f.relPath.split('/').pop() ?? '')) {
      const cls = /class\s+([A-Z]\w+)/.exec(f.content)?.[1] ?? f.relPath
      tests.push({ className: cls, file: f.relPath })
      continue
    }

    // Routes — group by file as a single virtual "controller" since
    // FastAPI routers don't have a class wrapper.
    const endpoints: RepoEndpoint[] = []
    ROUTE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ROUTE_RE.exec(f.content)) !== null) {
      endpoints.push({
        operationId: m[3],
        method: m[1].toUpperCase() as RepoEndpoint['method'],
        path: m[2],
        responseType: m[5] ?? undefined,
        routerFile: f.relPath,
      })
    }
    if (endpoints.length > 0) {
      controllers.push({ className: 'router', file: f.relPath, endpoints })
    }

    // Pydantic models
    PYDANTIC_CLASS_RE.lastIndex = 0
    let p: RegExpExecArray | null
    while ((p = PYDANTIC_CLASS_RE.exec(f.content)) !== null) {
      const name = p[1]
      const body = p[2]
      const fields: RepoModelField[] = []
      PY_FIELD_RE.lastIndex = 0
      let fm: RegExpExecArray | null
      while ((fm = PY_FIELD_RE.exec(body)) !== null) {
        fields.push({ name: fm[1], type: fm[2], required: !/Optional|\|\s*None|= None/.test(fm[2]) })
      }
      models.push({ name, file: f.relPath, kind: 'pydantic_model', fields })
    }

    // Services (class FooService:)
    SERVICE_CLASS_RE.lastIndex = 0
    let s: RegExpExecArray | null
    while ((s = SERVICE_CLASS_RE.exec(f.content)) !== null) {
      services.push({ className: `${s[1]}Service`, file: f.relPath, methods: [] })
    }

    const audit = AUDIT_LOGGER_RE.exec(f.content)
    if (audit) auditEvents.push({ loggerClass: 'auditLogger', file: f.relPath, eventName: audit[1] })
  }

  const contracts: RepoContract[] = []
  for (const f of otherFiles) {
    if (/openapi\.ya?ml$/.test(f.relPath)) contracts.push({ type: 'openapi', file: f.relPath })
  }

  return {
    application: {
      name: deriveAppName(repoPath),
      language: 'python',
      framework: 'fastapi',
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

function deriveAppName(repoPath: string): string {
  const segs = repoPath.split('/').filter(Boolean)
  return segs[segs.length - 1] ?? 'unknown-app'
}
