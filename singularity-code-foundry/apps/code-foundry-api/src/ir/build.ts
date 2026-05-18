/**
 * M42.1 — Spec → IR builder.
 *
 * Pure function. Same spec always produces the same IR. The IR is the
 * single input to the generators (M42.2) so any per-stack divergence
 * happens here, not in the templates.
 */
import { config } from '../config.js'
import { canonicalize } from '../spec/canonicalize.js'
import { sha256 } from '../spec/hash.js'
import type { ServiceSpec } from '../spec/schema.js'
import { coverageFor } from './coverage.js'
import { clientClassFor, controllerNameFor, httpAnnotation, serviceImplBase } from './naming.js'
import {
  yamlToFormat,
  yamlToJava,
  yamlToJsonType,
  yamlToPython,
  yamlToTs,
} from './typeMap.js'
import type {
  ApplicationIr,
  IrAudit,
  IrDataSource,
  IrEndpoint,
  IrField,
  IrModel,
  IrPathParam,
} from './types.js'

export interface BuildIrInput {
  spec: ServiceSpec
  specHash: string
  templateVersionOverride?: string
}

export function buildIr({ spec, specHash, templateVersionOverride }: BuildIrInput): ApplicationIr {
  const controllerName = controllerNameFor(spec)
  const serviceName = serviceImplBase(spec)

  const endpoints: IrEndpoint[] = spec.api.endpoints.map(ep => {
    const pathParams: IrPathParam[] = (ep.input?.pathParams ?? []).map(p => ({
      name: p.name,
      javaType: yamlToJava(p.type),
      pythonType: yamlToPython(p.type),
      tsType: yamlToTs(p.type),
      required: p.required,
    }))
    const coverage = coverageFor(spec, ep.operationId)
    return {
      operationId: ep.operationId,
      controllerName,
      serviceName,
      method: ep.method,
      httpAnnotation: httpAnnotation(ep.method),
      basePath: spec.api.basePath,
      routePath: ep.path,
      fullPath: joinPath(spec.api.basePath, ep.path),
      pathParams,
      responseType: ep.output.type,
      errors: ep.errors.map(e => ({ statusCode: e.statusCode, responseType: e.type })),
      businessLogicCoverage: coverage,
      deterministicBodyGeneration: coverage === 'FULL',
    }
  })

  const models: IrModel[] = (spec.models ?? []).map(m => ({
    name: m.name,
    fields: m.fields.map((f): IrField => ({
      name: f.name,
      javaType: yamlToJava(f.type, f.modelName),
      pythonType: yamlToPython(f.type, f.modelName),
      tsType: yamlToTs(f.type, f.modelName),
      jsonType: yamlToJsonType(f.type),
      required: f.required,
      description: f.description,
      format: yamlToFormat(f.type),
    })),
  }))

  const dataSources: IrDataSource[] = spec.dataSources.map(ds => ({
    name: ds.name,
    type: ds.type,
    clientClassName: ds.clientName ?? clientClassFor(ds.name),
    timeoutMs: ds.timeoutMs,
    hasResilience: Boolean(ds.resilience),
  }))

  const audit: IrAudit | undefined = spec.audit?.enabled
    ? {
        enabled: true,
        eventName:
          spec.audit.eventName ??
          `${spec.application.name.replace(/Service$/, '').toUpperCase()}_EVENT_RECORDED`,
        fields: spec.audit.fields,
      }
    : undefined

  const partial: Omit<ApplicationIr, 'meta'> = {
    application: {
      name: spec.application.name,
      groupId: spec.application.groupId,
      artifactId: spec.application.artifactId,
      packageName: spec.application.packageName,
      language: spec.application.language,
      framework: spec.application.framework,
      buildTool: spec.application.buildTool,
      javaVersion: spec.application.javaVersion,
      pythonVersion: spec.application.pythonVersion,
      nodeVersion: spec.application.nodeVersion,
    },
    endpoints,
    models,
    dataSources,
    audit,
  }
  const irHash = sha256(canonicalize(partial))
  const templateVersion =
    templateVersionOverride ??
    templateVersionFor(spec.application.framework) ??
    config.TEMPLATE_VERSION

  return {
    ...partial,
    meta: {
      specHash,
      irHash,
      generatorVersion: config.GENERATOR_VERSION,
      templateVersion,
    },
  }
}

function joinPath(base: string, route: string): string {
  const b = base.replace(/\/+$/, '')
  const r = route.startsWith('/') ? route : `/${route}`
  return `${b}${r}`
}

function templateVersionFor(framework: ServiceSpec['application']['framework']): string {
  // M42.1 only stamps the framework — actual generator versions arrive
  // in M42.2 alongside the template files. Receipts can be replayed
  // against this version string with no ambiguity.
  return `${framework}-spec-only-0.1.0`
}
