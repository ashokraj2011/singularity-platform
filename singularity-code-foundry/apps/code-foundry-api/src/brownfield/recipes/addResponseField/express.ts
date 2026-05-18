/**
 * M42.5 — ADD_RESPONSE_FIELD recipe: Express / TypeScript.
 *
 *   ADD_FIELD                  Add a Zod field to `z.object({ ... })`
 *                              and a matching property to the
 *                              `export interface` of the same model.
 *   UPDATE_OPENAPI_SCHEMA      YAML property append (shared YAML
 *                              helper).
 *   UPDATE_SERVICE_MAPPING     Insert llm-editable business-logic
 *                              region inside the service method.
 *   UPDATE_TEST_EXPECTATION    Insert llm-editable test-case region
 *                              inside the last test body.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fence } from '../../../regions/markers.js'
import type { RecipeContext, RecipeFn, RecipeOutput, LlmTaskSeed } from '../registry.js'
import type { ChangeOperation, EnhancementSpec } from '../../types.js'

export const addResponseFieldExpress: RecipeFn = (ctx) => {
  const op = ctx.operation
  switch (op.operation) {
    case 'ADD_FIELD':              return runAddField(ctx, op)
    case 'UPDATE_OPENAPI_SCHEMA':  return openApiPatch(ctx, op)
    case 'UPDATE_SERVICE_MAPPING': return runUpdateServiceMapping(ctx, op)
    case 'UPDATE_TEST_EXPECTATION': return runUpdateTestExpectation(ctx, op)
    default:
      return { editedFiles: [], llmTasks: [], notes: [`No-op for ${op.operation} in express recipe.`] }
  }
}

function runAddField(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  const filePath = op.targetFile
  const src = readSrc(ctx.repoPath, filePath)
  const targetClass = op.targetClass ?? ctx.enhancementSpec.enhancement.targetModel
  const fieldName = ctx.enhancementSpec.field.name
  const zodCall = mapZodCall(ctx.enhancementSpec.field.type, ctx.enhancementSpec.field.required !== false)
  const tsType = mapTsType(ctx.enhancementSpec.field.type, ctx.enhancementSpec.field.required !== false)

  let next = src
  let touchedZod = false
  let touchedIface = false

  // Zod schema (target name matches OR an obvious *Schema variant).
  const zodRe = new RegExp(`(const\\s+(?:${escapeRe(targetClass)}|${escapeRe(targetClass)}Schema|${escapeRe(lowerFirst(targetClass))}|${escapeRe(lowerFirst(targetClass))}Schema)\\s*=\\s*z\\.object\\s*\\(\\s*\\{)([\\s\\S]*?)(\\}\\s*\\))`)
  const zm = zodRe.exec(next)
  if (zm) {
    const before = zm[2].trimEnd()
    const sep = before.length > 0 && !before.endsWith(',') ? ',' : ''
    const newBlock = `${zm[1]}${before}${sep}\n  ${fieldName}: ${zodCall}\n${zm[3]}`
    next = next.slice(0, zm.index) + newBlock + next.slice(zm.index + zm[0].length)
    touchedZod = true
  }

  // TS interface declaration of the same name (or with `Dto` suffix).
  const ifRe = new RegExp(`(export\\s+interface\\s+(?:${escapeRe(targetClass)}|${escapeRe(targetClass)}Dto)\\s*(?:extends\\s+[^{]+)?\\{)([\\s\\S]*?)(\\n\\})`, 'm')
  const im = ifRe.exec(next)
  if (im) {
    const before = im[2].replace(/\s+$/, '')
    const sep = before.length > 0 && !before.endsWith(';') && !before.endsWith('\n') ? '' : ''
    const newBlock = `${im[1]}${before}${sep}\n  ${fieldName}${ctx.enhancementSpec.field.required !== false ? '' : '?'}: ${tsType};${im[3]}`
    next = next.slice(0, im.index) + newBlock + next.slice(im.index + im[0].length)
    touchedIface = true
  }

  if (!touchedZod && !touchedIface) {
    return { editedFiles: [], llmTasks: [], notes: [`No zod schema or interface named '${targetClass}' found in ${filePath}.`] }
  }
  const notes: string[] = []
  if (touchedZod) notes.push(`Added zod property '${fieldName}' to schema.`)
  if (touchedIface) notes.push(`Added interface property '${fieldName}' to ${targetClass}.`)
  return { editedFiles: [{ filePath, content: next }], llmTasks: [], notes }
}

function runUpdateServiceMapping(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  const filePath = op.targetFile
  const src = readSrc(ctx.repoPath, filePath)
  const methodName = op.targetMethod ?? ctx.enhancementSpec.enhancement.targetEndpoint
  const fieldName = ctx.enhancementSpec.field.name
  const sentinel = `// FOUNDRY: ${fieldName} mapping`
  if (src.includes(sentinel)) {
    return { editedFiles: [], llmTasks: tasksFor(ctx, op, 'business-logic', 'COMPLETE_MAPPING_LOGIC'), notes: ['Sentinel already present.'] }
  }
  // Match `methodName(...) { ... }` — either standalone fn or class method.
  const methRe = new RegExp(`(?:async\\s+)?(?:function\\s+)?${escapeRe(methodName)}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{`)
  const m = methRe.exec(src)
  if (!m) {
    return { editedFiles: [], llmTasks: [], notes: [`Service method '${methodName}' not found in ${filePath}.`] }
  }
  const insertAt = m.index + m[0].length
  const body = [
    `  ${sentinel}`,
    `  // TODO(Foundry): map '${fieldName}' from upstream context.`,
    `  const ${fieldName}Value: unknown = null;`,
  ].join('\n')
  const fenced = fence({
    marker: 'editable',
    regionId: 'business-logic',
    language: 'typescript',
    body,
  })
  const next = src.slice(0, insertAt) + '\n' + fenced + src.slice(insertAt)
  return {
    editedFiles: [{ filePath, content: next }],
    llmTasks: tasksFor(ctx, op, 'business-logic', 'COMPLETE_MAPPING_LOGIC'),
    notes: [`Inserted business-logic region for '${fieldName}' in ${methodName}.`],
  }
}

function runUpdateTestExpectation(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  const filePath = op.targetFile
  const src = readSrc(ctx.repoPath, filePath)
  const fieldName = ctx.enhancementSpec.field.name
  const sentinel = `// FOUNDRY: ${fieldName} assertion`
  if (src.includes(sentinel)) {
    return { editedFiles: [], llmTasks: tasksFor(ctx, op, 'test-case', 'UPDATE_TEST_ASSERTIONS'), notes: ['Sentinel already present.'] }
  }
  // Look for the LAST `it('...', () => { ... })` or `test('...', ...)` block.
  const testRe = /\b(?:it|test)\s*\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*(?:async\s*)?(?:\(\s*\)\s*=>|function\s*\(\s*\)\s*)\s*\{/g
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = testRe.exec(src)) !== null) last = m
  if (!last) {
    return { editedFiles: [], llmTasks: [], notes: [`No it()/test() block found in ${filePath}.`] }
  }
  // Balance braces.
  let depth = 0
  let closeIdx = -1
  for (let i = last.index + last[0].length; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      if (depth === 0) { closeIdx = i; break }
      depth--
    }
  }
  if (closeIdx === -1) {
    return { editedFiles: [], llmTasks: [], notes: [`Could not balance braces around last it()/test() block.`] }
  }
  const body = [
    `  ${sentinel}`,
    `  // TODO(Foundry): assert response.${fieldName} matches the expected value.`,
  ].join('\n')
  const fenced = fence({
    marker: 'editable',
    regionId: 'test-case',
    language: 'typescript',
    body,
  })
  const next = src.slice(0, closeIdx) + '\n' + fenced + src.slice(closeIdx)
  return {
    editedFiles: [{ filePath, content: next }],
    llmTasks: tasksFor(ctx, op, 'test-case', 'UPDATE_TEST_ASSERTIONS'),
    notes: [`Inserted test-case region for '${fieldName}' in ${filePath}.`],
  }
}

function openApiPatch(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  const filePath = op.targetFile
  const src = readSrc(ctx.repoPath, filePath)
  const schemaName = op.schemaName ?? ctx.enhancementSpec.enhancement.targetModel
  const fieldName = ctx.enhancementSpec.field.name
  const openapiType = mapOpenApiType(ctx.enhancementSpec.field.type)
  const lines = src.split(/\r?\n/)
  let schemaLine = -1, propertiesLine = -1, propertiesIndent = ''
  for (let i = 0; i < lines.length; i++) {
    if (schemaLine === -1 && new RegExp(`^\\s+${escapeRe(schemaName)}\\s*:\\s*$`).test(lines[i])) {
      schemaLine = i
      continue
    }
    if (schemaLine !== -1 && propertiesLine === -1) {
      const pm = /^(\s+)properties\s*:\s*$/.exec(lines[i])
      if (pm) { propertiesLine = i; propertiesIndent = pm[1]; break }
    }
  }
  if (propertiesLine === -1) {
    return { editedFiles: [], llmTasks: [], notes: [`OpenAPI schema '${schemaName}' missing properties block.`] }
  }
  const fieldIndent = `${propertiesIndent}  `
  const insertion = [
    `${fieldIndent}${fieldName}:`,
    `${fieldIndent}  type: ${openapiType.type}`,
    ...(openapiType.format ? [`${fieldIndent}  format: ${openapiType.format}`] : []),
  ]
  let endLine = lines.length
  for (let i = propertiesLine + 1; i < lines.length; i++) {
    const ln = lines[i]
    if (ln.trim() === '') continue
    const im = /^(\s*)/.exec(ln)
    if (im && im[1].length <= propertiesIndent.length) { endLine = i; break }
  }
  const next = [...lines.slice(0, endLine), ...insertion, ...lines.slice(endLine)].join('\n')
  return {
    editedFiles: [{ filePath, content: next }],
    llmTasks: [],
    notes: [`Added OpenAPI property '${fieldName}' to '${schemaName}'.`],
  }
}

function tasksFor(
  ctx: RecipeContext,
  op: ChangeOperation,
  regionId: 'business-logic' | 'test-case',
  taskType: LlmTaskSeed['taskType'],
): LlmTaskSeed[] {
  if (!op.llmEligible) return []
  return [{
    taskType,
    targetFile: op.targetFile,
    targetClass: op.targetClass,
    targetMethod: op.targetMethod,
    regionId,
    allowedChanges: regionId === 'business-logic' ? ['method_body_only'] : ['add_test_case', 'method_body_only'],
    forbiddenChanges: regionId === 'business-logic' ? ['add_field_to_dto', 'add_import_within_package'] : [],
    metadata: {
      enhancementType: ctx.enhancementSpec.enhancement.type,
      fieldName: ctx.enhancementSpec.field.name,
      fieldType: ctx.enhancementSpec.field.type,
      mappingHint: ctx.enhancementSpec.mapping?.source,
    },
  }]
}

function mapZodCall(yamlType: EnhancementSpec['field']['type'], required: boolean): string {
  const base = (() => {
    switch (yamlType) {
      case 'string':   return 'z.string()'
      case 'integer':
      case 'long':     return 'z.number().int()'
      case 'number':
      case 'double':   return 'z.number()'
      case 'boolean':  return 'z.boolean()'
      case 'datetime': return 'z.string().datetime()'
      case 'date':     return 'z.string()'
      case 'uuid':     return 'z.string().uuid()'
      default:         return 'z.string()'
    }
  })()
  return required ? base : `${base}.optional()`
}

function mapTsType(yamlType: EnhancementSpec['field']['type'], required: boolean): string {
  const base = (() => {
    switch (yamlType) {
      case 'string':
      case 'date':
      case 'uuid':
      case 'datetime': return 'string'
      case 'integer':
      case 'long':
      case 'number':
      case 'double':   return 'number'
      case 'boolean':  return 'boolean'
      default:         return 'string'
    }
  })()
  return required ? base : `${base} | undefined`
}

function mapOpenApiType(yamlType: EnhancementSpec['field']['type']): { type: string; format?: string } {
  switch (yamlType) {
    case 'integer': return { type: 'integer', format: 'int32' }
    case 'long':    return { type: 'integer', format: 'int64' }
    case 'number':
    case 'double':  return { type: 'number', format: 'double' }
    case 'boolean': return { type: 'boolean' }
    case 'datetime': return { type: 'string', format: 'date-time' }
    case 'date':    return { type: 'string', format: 'date' }
    case 'uuid':    return { type: 'string', format: 'uuid' }
    case 'string':
    default:        return { type: 'string' }
  }
}

function readSrc(repoPath: string, relPath: string): string {
  return readFileSync(join(repoPath, relPath), 'utf8')
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
