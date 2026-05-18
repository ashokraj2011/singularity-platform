/**
 * M42.5 — ADD_RESPONSE_FIELD recipe: FastAPI.
 *
 *   ADD_FIELD                  Append a pydantic field to the target
 *                              BaseModel subclass.
 *   UPDATE_OPENAPI_SCHEMA      Patch openapi.yaml the same way the
 *                              Spring recipe does (text-level YAML
 *                              edit). FastAPI also generates OpenAPI at
 *                              runtime; we only patch the static file
 *                              when it exists.
 *   UPDATE_SERVICE_MAPPING     Insert an llm-editable business-logic
 *                              region inside the service method body.
 *   UPDATE_TEST_EXPECTATION    Insert an llm-editable test-case region
 *                              at the bottom of the target test fn.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fence } from '../../../regions/markers.js'
import type { RecipeContext, RecipeFn, RecipeOutput, LlmTaskSeed } from '../registry.js'
import type { ChangeOperation, EnhancementSpec } from '../../types.js'

export const addResponseFieldFastApi: RecipeFn = (ctx) => {
  const op = ctx.operation
  switch (op.operation) {
    case 'ADD_FIELD':              return runAddField(ctx, op)
    case 'UPDATE_OPENAPI_SCHEMA':  return runUpdateOpenApi(ctx, op)
    case 'UPDATE_SERVICE_MAPPING': return runUpdateServiceMapping(ctx, op)
    case 'UPDATE_TEST_EXPECTATION': return runUpdateTestExpectation(ctx, op)
    default:
      return { editedFiles: [], llmTasks: [], notes: [`No-op for ${op.operation} in fastapi recipe.`] }
  }
}

function runAddField(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  const filePath = op.targetFile
  const src = readSrc(ctx.repoPath, filePath)
  const targetClass = op.targetClass ?? ctx.enhancementSpec.enhancement.targetModel
  const pyType = mapPyType(ctx.enhancementSpec.field.type)
  const fieldName = ctx.enhancementSpec.field.name
  const required = ctx.enhancementSpec.field.required !== false

  const classRe = new RegExp(`(class\\s+${escapeRe(targetClass)}\\s*\\(\\s*BaseModel(?:\\s*,\\s*[^)]+)?\\s*\\)\\s*:\\s*\\n)([\\s\\S]*?)(?=^\\S|\\Z)`, 'm')
  const m = classRe.exec(src)
  if (!m) {
    return { editedFiles: [], llmTasks: [], notes: [`Could not find pydantic class '${targetClass}' in ${filePath}.`] }
  }
  const body = m[2]
  // Detect base indent of existing fields ("    " for 4-space pydantic norm).
  const indentMatch = /^(\s+)\S/m.exec(body)
  const indent = indentMatch ? indentMatch[1] : '    '
  const valueExpr = required ? '' : ' = None'
  const annotation = required ? pyType : `Optional[${pyType}]`
  // Append the new field line at the end of the class body, before
  // the first non-indented (or class-end) line. Easiest place: just
  // after the matched block.
  const insertAt = m.index + m[0].length
  const newField = `${indent}${fieldName}: ${annotation}${valueExpr}\n`
  const next = src.slice(0, insertAt) + newField + src.slice(insertAt)
  return {
    editedFiles: [{ filePath, content: next }],
    llmTasks: [],
    notes: [`Added pydantic field '${fieldName}: ${annotation}' to ${targetClass}.`],
  }
}

function runUpdateOpenApi(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  // Identical YAML editing as Spring recipe — reuses the same helper.
  return openApiPatch(ctx, op)
}

function runUpdateServiceMapping(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  const filePath = op.targetFile
  const src = readSrc(ctx.repoPath, filePath)
  const methodName = op.targetMethod ?? ctx.enhancementSpec.enhancement.targetEndpoint
  const fieldName = ctx.enhancementSpec.field.name
  const sentinel = `# FOUNDRY: ${fieldName} mapping`

  if (src.includes(sentinel)) {
    return { editedFiles: [], llmTasks: tasksFor(ctx, op, 'business-logic', 'COMPLETE_MAPPING_LOGIC'), notes: ['Sentinel already present.'] }
  }
  const fnRe = new RegExp(`def\\s+${escapeRe(methodName)}\\s*\\([^)]*\\)\\s*(?:->\\s*[^:]+)?:\\s*\\n`)
  const m = fnRe.exec(src)
  if (!m) {
    return { editedFiles: [], llmTasks: [], notes: [`Service method '${methodName}' not found in ${filePath}.`] }
  }
  const insertAt = m.index + m[0].length
  // Detect indent (next non-empty line).
  const tail = src.slice(insertAt)
  const indentMatch = /^(\s+)\S/m.exec(tail)
  const indent = indentMatch ? indentMatch[1] : '    '
  const body = [
    `${indent}${sentinel}`,
    `${indent}# TODO(Foundry): map '${fieldName}' from upstream context.`,
    `${indent}${fieldName}_value = None`,
  ].join('\n')
  const fenced = fence({
    marker: 'editable',
    regionId: 'business-logic',
    language: 'python',
    body,
  })
  const next = src.slice(0, insertAt) + fenced + src.slice(insertAt)
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
  const sentinel = `# FOUNDRY: ${fieldName} assertion`
  if (src.includes(sentinel)) {
    return { editedFiles: [], llmTasks: tasksFor(ctx, op, 'test-case', 'UPDATE_TEST_ASSERTIONS'), notes: ['Sentinel already present.'] }
  }
  // Find the LAST `def test_…` and append before end-of-function (next
  // top-level statement or EOF).
  const testRe = /^def\s+test_\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*\n/gm
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = testRe.exec(src)) !== null) last = m
  if (!last) {
    return { editedFiles: [], llmTasks: [], notes: [`No test_… function found in ${filePath}.`] }
  }
  // Find next top-level def/class or EOF.
  const startBody = last.index + last[0].length
  const nextTopLevel = /^(?:def|class)\s+/m.exec(src.slice(startBody))
  const insertAt = nextTopLevel ? startBody + nextTopLevel.index : src.length
  const indent = '    '
  const body = [
    `${indent}${sentinel}`,
    `${indent}# TODO(Foundry): assert response.${fieldName} matches the expected value.`,
  ].join('\n')
  const fenced = fence({
    marker: 'editable',
    regionId: 'test-case',
    language: 'python',
    body,
  })
  const next = src.slice(0, insertAt) + fenced + '\n' + src.slice(insertAt)
  return {
    editedFiles: [{ filePath, content: next }],
    llmTasks: tasksFor(ctx, op, 'test-case', 'UPDATE_TEST_ASSERTIONS'),
    notes: [`Inserted test-case region for '${fieldName}' in ${filePath}.`],
  }
}

// ─── Shared YAML helpers ───────────────────────────────────────────────────

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

function mapPyType(yamlType: EnhancementSpec['field']['type']): string {
  switch (yamlType) {
    case 'string':   return 'str'
    case 'integer':
    case 'long':     return 'int'
    case 'number':
    case 'double':   return 'float'
    case 'boolean':  return 'bool'
    case 'datetime': return 'datetime'
    case 'date':     return 'date'
    case 'uuid':     return 'UUID'
    default:         return 'str'
  }
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
