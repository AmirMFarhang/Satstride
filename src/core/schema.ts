// A strict JSON Schema subset, enough for the scoring contract's output schema
// and the term sheet. Objects are closed: a key the schema does not name is an
// error, which is what makes an output schema a leak check. Unsupported
// keywords throw instead of being ignored, so a schema cannot silently weaken.

export type JsonSchema =
  | { type: 'object'; properties: Record<string, JsonSchema>; required?: string[]; additionalProperties?: false; description?: string }
  | { type: 'array'; items: JsonSchema; maxItems?: number; minItems?: number; description?: string }
  | { type: 'string'; enum?: string[]; const?: string; pattern?: string; maxLength?: number; minLength?: number; description?: string }
  | { type: 'integer'; minimum?: number; maximum?: number; const?: number; description?: string }
  | { type: 'number'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; const?: boolean; description?: string }
  | { type: 'null'; description?: string }
  | { oneOf: JsonSchema[]; description?: string }

const KNOWN: Record<string, ReadonlySet<string>> = {
  object: new Set(['type', 'properties', 'required', 'additionalProperties', 'description']),
  array: new Set(['type', 'items', 'maxItems', 'minItems', 'description']),
  string: new Set(['type', 'enum', 'const', 'pattern', 'maxLength', 'minLength', 'description']),
  integer: new Set(['type', 'minimum', 'maximum', 'const', 'description']),
  number: new Set(['type', 'minimum', 'maximum', 'description']),
  boolean: new Set(['type', 'const', 'description']),
  null: new Set(['type', 'description']),
  oneOf: new Set(['oneOf', 'description']),
}

/** Every problem, each prefixed with its JSON path. An empty list means valid. */
export function schemaErrors(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const kind = 'oneOf' in schema ? 'oneOf' : schema.type
  const known = KNOWN[kind]
  if (!known) throw new Error(`schema at ${path}: unsupported type ${String(kind)}`)
  for (const key of Object.keys(schema)) if (!known.has(key)) throw new Error(`schema at ${path}: unsupported keyword ${key}`)
  if ('oneOf' in schema) {
    const matches = schema.oneOf.filter((option) => schemaErrors(value, option, path).length === 0).length
    return matches === 1 ? [] : [`${path}: must match exactly one alternative, matched ${matches}`]
  }
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: must be an object`]
      if (schema.additionalProperties !== false) throw new Error(`schema at ${path}: objects must set additionalProperties: false`)
      const errors: string[] = []
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) errors.push(`${path}.${key}: field not allowed`)
        else if (record[key] !== undefined) errors.push(...schemaErrors(record[key], schema.properties[key], `${path}.${key}`))
      }
      for (const key of schema.required ?? []) if (record[key] === undefined) errors.push(`${path}.${key}: required`)
      return errors
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${path}: must be an array`]
      const errors: string[] = []
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: at most ${schema.maxItems} items`)
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: at least ${schema.minItems} items`)
      value.forEach((item, i) => errors.push(...schemaErrors(item, schema.items, `${path}[${i}]`)))
      return errors
    }
    case 'string': {
      if (typeof value !== 'string') return [`${path}: must be a string`]
      if (schema.const !== undefined && value !== schema.const) return [`${path}: must be ${JSON.stringify(schema.const)}`]
      if (schema.enum && !schema.enum.includes(value)) return [`${path}: must be one of ${schema.enum.join(', ')}`]
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return [`${path}: at most ${schema.maxLength} characters`]
      if (schema.minLength !== undefined && value.length < schema.minLength) return [`${path}: at least ${schema.minLength} characters`]
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return [`${path}: does not match ${schema.pattern}`]
      return []
    }
    case 'integer': {
      if (!Number.isSafeInteger(value)) return [`${path}: must be a safe integer`]
      const n = value as number
      if (schema.const !== undefined && n !== schema.const) return [`${path}: must be ${schema.const}`]
      if (schema.minimum !== undefined && n < schema.minimum) return [`${path}: must be >= ${schema.minimum}`]
      if (schema.maximum !== undefined && n > schema.maximum) return [`${path}: must be <= ${schema.maximum}`]
      return []
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: must be a finite number`]
      if (schema.minimum !== undefined && value < schema.minimum) return [`${path}: must be >= ${schema.minimum}`]
      if (schema.maximum !== undefined && value > schema.maximum) return [`${path}: must be <= ${schema.maximum}`]
      return []
    }
    case 'boolean':
      if (typeof value !== 'boolean') return [`${path}: must be a boolean`]
      return schema.const !== undefined && value !== schema.const ? [`${path}: must be ${schema.const}`] : []
    case 'null':
      return value === null ? [] : [`${path}: must be null`]
  }
}

export const HEX32_PATTERN = '^[0-9a-f]{64}$'
export const HEX64_PATTERN = '^[0-9a-f]{128}$'
