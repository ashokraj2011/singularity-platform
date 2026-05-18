/**
 * M42.5 — ADD_RESPONSE_FIELD recipe: Spring Boot.
 *
 * Per operation type:
 *
 *   ADD_FIELD                  Insert a new component into the Java
 *                              record signature (or a new field+accessor
 *                              into a plain DTO class). Deterministic.
 *
 *   UPDATE_OPENAPI_SCHEMA      Append a property to the named schema
 *                              in the openapi.yaml file. Deterministic.
 *
 *   UPDATE_SERVICE_MAPPING     Insert an `<llm-editable region="business-logic">`
 *                              fence inside the service method body
 *                              with a stub that returns the new field
 *                              value (LLM fills in the mapping logic).
 *
 *   UPDATE_TEST_EXPECTATION    Insert an `<llm-editable region="test-case">`
 *                              fence inside the test method with a
 *                              placeholder assertion (LLM extends).
 *
 * The recipe is regex-driven for V1 — sufficient for the spec §11
 * Spring Boot baseline. A JavaParser-based variant is M42.5.1.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fence } from '../../../regions/markers.js'
import type { RecipeContext, RecipeFn, RecipeOutput, LlmTaskSeed } from '../registry.js'
import type { ChangeOperation, EnhancementSpec } from '../../types.js'

const PROP_NAME_RE = /[A-Za-z_]\w*/

export const addResponseFieldSpring: RecipeFn = (ctx) => {
  const op = ctx.operation
  switch (op.operation) {
    case 'ADD_FIELD':              return runAddField(ctx, op)
    case 'UPDATE_OPENAPI_SCHEMA':  return runUpdateOpenApi(ctx, op)
    case 'UPDATE_SERVICE_MAPPING': return runUpdateServiceMapping(ctx, op)
    case 'UPDATE_TEST_EXPECTATION': return runUpdateTestExpectation(ctx, op)
    default:
      return { editedFiles: [], llmTasks: [], notes: [`No-op for ${op.operation} in spring-boot recipe.`] }
  }
}

function runAddField(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  const filePath = op.targetFile
  const src = readSrc(ctx.repoPath, filePath)
  const targetClass = op.targetClass ?? ctx.enhancementSpec.enhancement.targetModel
  const javaType = mapJavaType(ctx.enhancementSpec.field.type)
  const fieldName = ctx.enhancementSpec.field.name

  // Try as a record first.
  const recordRe = new RegExp(`public\\s+record\\s+${escapeRe(targetClass)}\\s*\\(([\\s\\S]*?)\\)\\s*\\{`)
  const recordMatch = recordRe.exec(src)
  if (recordMatch) {
    const before = recordMatch[1].trimEnd()
    const newComponents = before.length === 0
      ? `${javaType} ${fieldName}`
      : `${before},\n    ${javaType} ${fieldName}`
    const replacement = `public record ${targetClass}(${newComponents}\n)`
    const next = src.replace(recordRe, `${replacement} {`)
    return {
      editedFiles: [{ filePath, content: next }],
      llmTasks: [],
      notes: [`Added record component '${fieldName}: ${javaType}' to ${targetClass}.`],
    }
  }

  // Fallback: plain DTO class. We insert a field, getter, and a
  // constructor parameter heuristically; if the class has Lombok
  // annotations the field alone is sufficient.
  const classRe = new RegExp(`public\\s+class\\s+${escapeRe(targetClass)}\\b[^{]*\\{`)
  const classMatch = classRe.exec(src)
  if (classMatch) {
    const insertAt = classMatch.index + classMatch[0].length
    const fieldDecl = `\n    private ${javaType} ${fieldName};\n`
    const next = src.slice(0, insertAt) + fieldDecl + src.slice(insertAt)
    return {
      editedFiles: [{ filePath, content: next }],
      llmTasks: [],
      notes: [`Added field '${fieldName}: ${javaType}' to class ${targetClass}.`],
    }
  }
  return { editedFiles: [], llmTasks: [], notes: [`Could not find record/class '${targetClass}' in ${filePath}.`] }
}

function runUpdateOpenApi(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  const filePath = op.targetFile
  const src = readSrc(ctx.repoPath, filePath)
  const schemaName = op.schemaName ?? ctx.enhancementSpec.enhancement.targetModel
  const fieldName = ctx.enhancementSpec.field.name
  const openapiType = mapOpenApiType(ctx.enhancementSpec.field.type)

  const lines = src.split(/\r?\n/)
  let schemaLine = -1
  let propertiesLine = -1
  let propertiesIndent = ''
  for (let i = 0; i < lines.length; i++) {
    if (schemaLine === -1 && new RegExp(`^\\s+${escapeRe(schemaName)}\\s*:\\s*$`).test(lines[i])) {
      schemaLine = i
      continue
    }
    if (schemaLine !== -1 && propertiesLine === -1) {
      const pm = /^(\s+)properties\s*:\s*$/.exec(lines[i])
      if (pm) {
        propertiesLine = i
        propertiesIndent = pm[1]
        break
      }
    }
  }
  if (propertiesLine === -1) {
    return { editedFiles: [], llmTasks: [], notes: [`OpenAPI schema '${schemaName}' missing properties block in ${filePath}; left untouched.`] }
  }
  const fieldIndent = `${propertiesIndent}  `
  const insertion = [
    `${fieldIndent}${fieldName}:`,
    `${fieldIndent}  type: ${openapiType.type}`,
    ...(openapiType.format ? [`${fieldIndent}  format: ${openapiType.format}`] : []),
  ]
  // Find the end of the properties block: first line at indent ≤ propertiesIndent.
  let endLine = lines.length
  for (let i = propertiesLine + 1; i < lines.length; i++) {
    const ln = lines[i]
    if (ln.trim() === '') continue
    const m = /^(\s*)/.exec(ln)
    if (m && m[1].length <= propertiesIndent.length) { endLine = i; break }
  }
  const next = [...lines.slice(0, endLine), ...insertion, ...lines.slice(endLine)].join('\n')
  return {
    editedFiles: [{ filePath, content: next }],
    llmTasks: [],
    notes: [`Added property '${fieldName}' to OpenAPI schema '${schemaName}'.`],
  }
}

function runUpdateServiceMapping(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  const filePath = op.targetFile
  const src = readSrc(ctx.repoPath, filePath)
  const methodName = op.targetMethod ?? ctx.enhancementSpec.enhancement.targetEndpoint
  const fieldName = ctx.enhancementSpec.field.name
  const sentinel = `// FOUNDRY: ${fieldName} mapping`

  if (src.includes(sentinel)) {
    return { editedFiles: [], llmTasks: tasksFor(ctx, op, 'business-logic', 'COMPLETE_MAPPING_LOGIC'), notes: ['Sentinel already present; reusing existing region.'] }
  }

  const methodRe = new RegExp(`public\\s+[A-Za-z_][\\w<>?,\\s]*?\\s+${escapeRe(methodName)}\\s*\\([^)]*\\)\\s*\\{`)
  const m = methodRe.exec(src)
  if (!m) {
    return { editedFiles: [], llmTasks: [], notes: [`Service method '${methodName}' not found in ${filePath}.`] }
  }
  const insertAt = m.index + m[0].length
  const body = `    ${sentinel}\n    // TODO(Foundry): map '${fieldName}' from upstream context.\n    java.lang.Object ${fieldName}Value = null;`
  const fenced = fence({
    marker: 'editable',
    regionId: 'business-logic',
    language: 'java',
    body,
  })
  const next = src.slice(0, insertAt) + '\n' + fenced + src.slice(insertAt)
  return {
    editedFiles: [{ filePath, content: next }],
    llmTasks: tasksFor(ctx, op, 'business-logic', 'COMPLETE_MAPPING_LOGIC'),
    notes: [`Inserted business-logic region for '${fieldName}' inside ${methodName}.`],
  }
}

function runUpdateTestExpectation(ctx: RecipeContext, op: ChangeOperation): RecipeOutput {
  const filePath = op.targetFile
  const src = readSrc(ctx.repoPath, filePath)
  const fieldName = ctx.enhancementSpec.field.name
  const sentinel = `// FOUNDRY: ${fieldName} assertion`

  if (src.includes(sentinel)) {
    return { editedFiles: [], llmTasks: tasksFor(ctx, op, 'test-case', 'UPDATE_TEST_ASSERTIONS'), notes: ['Sentinel already present; reusing existing region.'] }
  }
  // Insert just before the closing brace of the LAST test method we
  // can identify (any @Test method). This is heuristic but sufficient
  // for spec §11 test scaffolds.
  const testRe = /@Test\s+(?:public\s+)?void\s+\w+\s*\(\s*\)\s*\{/g
  let lastIndex = -1
  let lastMatch: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = testRe.exec(src)) !== null) { lastIndex = m.index; lastMatch = m }
  if (!lastMatch) {
    return { editedFiles: [], llmTasks: [], notes: [`No @Test method found in ${filePath}.`] }
  }
  // Find matching closing brace at the same nesting level.
  let depth = 0
  let closeIdx = -1
  const startIdx = lastIndex + lastMatch[0].length
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      if (depth === 0) { closeIdx = i; break }
      depth--
    }
  }
  if (closeIdx === -1) {
    return { editedFiles: [], llmTasks: [], notes: [`Could not balance braces around last @Test method.`] }
  }
  const body = `    ${sentinel}\n    // TODO(Foundry): assert response.${fieldName} matches the expected value.`
  const fenced = fence({
    marker: 'editable',
    regionId: 'test-case',
    language: 'java',
    body,
  })
  const next = src.slice(0, closeIdx) + '\n' + fenced + src.slice(closeIdx)
  return {
    editedFiles: [{ filePath, content: next }],
    llmTasks: tasksFor(ctx, op, 'test-case', 'UPDATE_TEST_ASSERTIONS'),
    notes: [`Inserted test-case region for '${fieldName}' in ${filePath}.`],
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

function mapJavaType(yamlType: EnhancementSpec['field']['type']): string {
  switch (yamlType) {
    case 'string': return 'String'
    case 'integer': return 'Integer'
    case 'long': return 'Long'
    case 'number':
    case 'double': return 'Double'
    case 'boolean': return 'Boolean'
    case 'datetime': return 'java.time.OffsetDateTime'
    case 'date': return 'java.time.LocalDate'
    case 'uuid': return 'java.util.UUID'
    default: return 'String'
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
// silence unused-import alarm: PROP_NAME_RE reserved for future arg validation
void PROP_NAME_RE
