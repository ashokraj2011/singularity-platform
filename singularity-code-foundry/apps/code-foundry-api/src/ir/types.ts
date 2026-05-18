/**
 * M42.1 — Application IR.
 *
 * Mirrors spec §8.5 example. The IR is the canonical input the M42.2
 * generators consume. It resolves per-stack names, fully-qualified
 * paths, and per-endpoint coverage tags so generator templates don't
 * have to re-derive them on every render.
 */
export type Language = 'java' | 'python' | 'typescript'
export type Framework = 'spring-boot' | 'fastapi' | 'express'
export type BusinessLogicCoverage = 'FULL' | 'PARTIAL' | 'NONE'

export interface IrPathParam {
  name: string
  javaType: string
  pythonType: string
  tsType: string
  required: boolean
}

export interface IrEndpoint {
  operationId: string
  controllerName: string
  serviceName: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  httpAnnotation: 'GetMapping' | 'PostMapping' | 'PutMapping' | 'PatchMapping' | 'DeleteMapping'
  basePath: string
  routePath: string
  fullPath: string
  pathParams: IrPathParam[]
  responseType: string
  errors: Array<{ statusCode: number; responseType: string }>
  businessLogicCoverage: BusinessLogicCoverage
  deterministicBodyGeneration: boolean
}

export interface IrField {
  name: string
  javaType: string
  pythonType: string
  tsType: string
  jsonType: string
  required: boolean
  description?: string
  format?: string
}

export interface IrModel {
  name: string
  fields: IrField[]
}

export interface IrDataSource {
  name: string
  type: string
  clientClassName: string
  timeoutMs?: number
  hasResilience: boolean
}

export interface IrAudit {
  enabled: boolean
  eventName: string
  fields: string[]
}

export interface ApplicationIr {
  application: {
    name: string
    groupId: string
    artifactId: string
    packageName: string
    language: Language
    framework: Framework
    buildTool: string
    javaVersion?: string
    pythonVersion?: string
    nodeVersion?: string
  }
  endpoints: IrEndpoint[]
  models: IrModel[]
  dataSources: IrDataSource[]
  audit?: IrAudit
  // Hash anchors carried with the IR so the receipt can reference them
  // without re-canonicalising.
  meta: {
    specHash: string
    irHash: string
    generatorVersion: string
    templateVersion: string
  }
}
