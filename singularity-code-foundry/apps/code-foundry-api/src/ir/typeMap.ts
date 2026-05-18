/**
 * M42.1 — Per-stack type mapping for IR builder.
 *
 * Generators (M42.2) will lean on these directly so templates can stay
 * dumb. Adding a new spec type is one entry in each map; adding a new
 * stack later requires extending each function.
 */

type YamlType =
  | 'string'
  | 'integer'
  | 'long'
  | 'number'
  | 'double'
  | 'boolean'
  | 'datetime'
  | 'date'
  | 'object'
  | 'array'
  | 'uuid'

export function yamlToJava(t: YamlType, modelName?: string): string {
  switch (t) {
    case 'string':   return 'String'
    case 'integer':  return 'Integer'
    case 'long':     return 'Long'
    case 'number':
    case 'double':   return 'Double'
    case 'boolean':  return 'Boolean'
    case 'datetime': return 'OffsetDateTime'
    case 'date':     return 'LocalDate'
    case 'uuid':     return 'UUID'
    case 'object':   return modelName ?? 'Object'
    case 'array':    return modelName ? `List<${modelName}>` : 'List<Object>'
  }
}

export function yamlToPython(t: YamlType, modelName?: string): string {
  switch (t) {
    case 'string':   return 'str'
    case 'integer':
    case 'long':     return 'int'
    case 'number':
    case 'double':   return 'float'
    case 'boolean':  return 'bool'
    case 'datetime': return 'datetime'
    case 'date':     return 'date'
    case 'uuid':     return 'UUID'
    case 'object':   return modelName ?? 'dict'
    case 'array':    return modelName ? `list[${modelName}]` : 'list'
  }
}

export function yamlToTs(t: YamlType, modelName?: string): string {
  switch (t) {
    case 'string':
    case 'datetime':
    case 'date':
    case 'uuid':     return 'string'
    case 'integer':
    case 'long':
    case 'number':
    case 'double':   return 'number'
    case 'boolean':  return 'boolean'
    case 'object':   return modelName ?? 'Record<string, unknown>'
    case 'array':    return modelName ? `${modelName}[]` : 'unknown[]'
  }
}

export function yamlToJsonType(t: YamlType): string {
  switch (t) {
    case 'string':
    case 'uuid':     return 'string'
    case 'datetime': return 'string'
    case 'date':     return 'string'
    case 'integer':
    case 'long':     return 'integer'
    case 'number':
    case 'double':   return 'number'
    case 'boolean':  return 'boolean'
    case 'object':   return 'object'
    case 'array':    return 'array'
  }
}

export function yamlToFormat(t: YamlType): string | undefined {
  if (t === 'datetime') return 'date-time'
  if (t === 'date') return 'date'
  if (t === 'uuid') return 'uuid'
  return undefined
}
