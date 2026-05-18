/**
 * M42.5 — Spring Boot Repo Scanner (regex-based for V1).
 *
 * Walks src/main/java for controllers, services, DTOs, audit loggers;
 * src/main/resources for application.yml + openapi.yml; src/test/java
 * for tests. Produces a RepoModel that the impact analyzer + planner
 * consume.
 *
 * Regex-based — sufficient to find the canonical spec §11 shapes
 * (controller annotations, java records, @Service classes, audit
 * MDC.put calls). A JavaParser-based scanner that handles edge cases
 * (multi-line annotations, generics, Lombok @Builder) is M42.5.1
 * follow-up.
 */
import { walkRepo, type SourceFile } from './common.js'
import type {
  RepoModel, RepoEndpoint, RepoModelEntry, RepoModelField,
  RepoService, RepoTest, RepoContract, RepoAuditEvent,
} from '../types.js'

const PACKAGE_RE = /^\s*package\s+([a-zA-Z_][\w.]*)\s*;/m

const REST_CONTROLLER_RE = /@RestController\s*(?:\([^)]*\))?\s*(?:@RequestMapping\s*\(\s*"([^"]+)"\s*\))?\s*public\s+class\s+([A-Z]\w+)/
const ENDPOINT_RE = /@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:"([^"]+)"|value\s*=\s*"([^"]+)")?\s*\)\s*public\s+([A-Z]\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/g

const RECORD_RE = /public\s+record\s+([A-Z]\w+)\s*\(([\s\S]*?)\)\s*\{/g
const CLASS_FIELDS_RE = /public\s+class\s+([A-Z]\w+)[^{]*\{([\s\S]+?)^}/gm
const FIELD_LINE_RE = /(?:private|public|protected)\s+(?:final\s+)?([A-Za-z_][\w<>?]*)\s+([a-zA-Z_]\w*)\s*(?:=|;)/g

const SERVICE_CLASS_RE = /@Service\s*(?:\([^)]*\))?\s*public\s+class\s+([A-Z]\w+)(?:\s+implements\s+([A-Z]\w+))?/
const METHOD_RE = /public\s+([A-Za-z_][\w<>,?\s]*?)\s+(\w+)\s*\(([^)]*)\)/g

const AUDIT_EVENT_RE = /private\s+static\s+final\s+String\s+EVENT_NAME\s*=\s*"([^"]+)"/
const SECURITY_FILE_HINTS = ['SecurityConfig', 'WebSecurity']

export function scanSpringBoot(repoPath: string): RepoModel {
  const javaFiles: SourceFile[] = []
  const otherFiles: SourceFile[] = []
  // Walk Java + a small set of resources (yml).
  for (const f of walkRepo(repoPath, new Set(['.java', '.yml', '.yaml', '.xml']))) {
    if (f.relPath.endsWith('.java')) javaFiles.push(f)
    else otherFiles.push(f)
  }

  const controllers: RepoModel['controllers'] = []
  const models: RepoModelEntry[] = []
  const services: RepoService[] = []
  const tests: RepoTest[] = []
  const auditEvents: RepoAuditEvent[] = []
  const securityConfigFiles: string[] = []
  let appName = packageRoot(javaFiles) ?? ''

  for (const f of javaFiles) {
    // Tests live under src/test/java; we record + skip them for the
    // controller/model walk so we don't double-classify.
    if (f.relPath.includes('src/test/')) {
      const cls = /\bclass\s+([A-Z]\w+)/.exec(f.content)?.[1]
      if (cls) tests.push({ className: cls, file: f.relPath })
      continue
    }

    // Controllers
    const ctrl = REST_CONTROLLER_RE.exec(f.content)
    if (ctrl) {
      const className = ctrl[2]
      const basePath = ctrl[1]
      const endpoints: RepoEndpoint[] = []
      ENDPOINT_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = ENDPOINT_RE.exec(f.content)) !== null) {
        const method = m[1].toUpperCase() as RepoEndpoint['method']
        const path = (m[2] ?? m[3] ?? '').toString()
        endpoints.push({
          operationId: m[5],
          method,
          path: basePath ? joinPath(basePath, path) : path,
          responseType: stripGenerics(m[4]),
          controllerClass: className,
        })
      }
      controllers.push({ className, file: f.relPath, basePath, endpoints })
      continue
    }

    // Services
    const svc = SERVICE_CLASS_RE.exec(f.content)
    if (svc) {
      const className = svc[1]
      const methods: RepoService['methods'] = []
      METHOD_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = METHOD_RE.exec(f.content)) !== null) {
        const returnType = stripGenerics(m[1].trim())
        const name = m[2]
        if (name === className || name.startsWith('_')) continue
        const params = m[3].split(',').map(s => s.trim()).filter(Boolean).map(p => {
          const parts = p.split(/\s+/)
          return { name: parts[parts.length - 1].replace(/[^\w]/g, ''), type: parts.slice(0, -1).join(' ').trim() }
        })
        methods.push({ name, returnType, parameters: params })
      }
      services.push({ className, file: f.relPath, methods })
      continue
    }

    // Records (DTOs)
    RECORD_RE.lastIndex = 0
    let r: RegExpExecArray | null
    while ((r = RECORD_RE.exec(f.content)) !== null) {
      const name = r[1]
      const fields = parseRecordFields(r[2])
      models.push({ name, file: f.relPath, kind: 'record', fields })
    }

    // Plain classes (only if no record matched).
    if (!RECORD_RE.test(f.content)) {
      CLASS_FIELDS_RE.lastIndex = 0
      let c: RegExpExecArray | null
      while ((c = CLASS_FIELDS_RE.exec(f.content)) !== null) {
        const name = c[1]
        const body = c[2]
        // Heuristic: only treat as a "model" class if it's in /model/ or /dto/.
        if (!f.relPath.includes('/model/') && !f.relPath.includes('/dto/')) continue
        const fields: RepoModelField[] = []
        FIELD_LINE_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = FIELD_LINE_RE.exec(body)) !== null) {
          fields.push({ name: m[2], type: stripGenerics(m[1]), required: true })
        }
        if (fields.length > 0) {
          models.push({ name, file: f.relPath, kind: 'class', fields })
        }
      }
    }

    // Audit logger
    const audit = AUDIT_EVENT_RE.exec(f.content)
    if (audit && /Logger\b|AuditLogger\b|MDC\.put/.test(f.content)) {
      const cls = /\bclass\s+([A-Z]\w+)/.exec(f.content)?.[1]
      auditEvents.push({ loggerClass: cls ?? 'unknown', file: f.relPath, eventName: audit[1] })
    }

    // Security
    if (SECURITY_FILE_HINTS.some(h => f.content.includes(h))) {
      securityConfigFiles.push(f.relPath)
    }
  }

  const contracts: RepoContract[] = []
  for (const f of otherFiles) {
    if (/openapi\.ya?ml$/.test(f.relPath) || /swagger\.ya?ml$/.test(f.relPath)) {
      contracts.push({ type: /swagger/.test(f.relPath) ? 'swagger' : 'openapi', file: f.relPath })
    }
  }

  return {
    application: {
      name: deriveAppName(repoPath),
      language: 'java',
      framework: 'spring-boot',
      packageName: appName,
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

function parseRecordFields(body: string): RepoModelField[] {
  // body is the parenthesised parameter list of a Java record. Strip
  // newlines/comments and split on commas at top level (records don't
  // nest parens at this depth, so a naïve split is sufficient).
  const flat = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim()
  if (!flat) return []
  const parts = flat.split(',').map(p => p.trim()).filter(Boolean)
  const fields: RepoModelField[] = []
  for (const part of parts) {
    // Strip @Jackson annotations + value.
    const cleaned = part.replace(/@\w+(\s*\([^)]*\))?\s*/g, '')
    const tokens = cleaned.split(/\s+/).filter(Boolean)
    if (tokens.length < 2) continue
    const name = tokens[tokens.length - 1].replace(/[^\w]/g, '')
    const type = tokens.slice(0, -1).join(' ').trim()
    fields.push({ name, type, required: true })
  }
  return fields
}

function stripGenerics(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function joinPath(base: string, route: string): string {
  const b = base.replace(/\/+$/, '')
  const r = route.startsWith('/') ? route : `/${route}`
  return `${b}${r}`
}

function packageRoot(files: SourceFile[]): string | undefined {
  for (const f of files) {
    const m = PACKAGE_RE.exec(f.content)
    if (m) return m[1]
  }
  return undefined
}

function deriveAppName(repoPath: string): string {
  const segs = repoPath.split('/').filter(Boolean)
  return segs[segs.length - 1] ?? 'unknown-app'
}
