import schemaSource from '../../shared/log-schema-v2.json'

interface FieldDefinition {
  type: 'integer' | 'string' | 'object'
  required: boolean
  nonBlank?: boolean
  values?: string[]
  format?: string
  nullable?: boolean
}

interface LogSchema {
  version: number
  versionField: string
  unknownFields: 'reject'
  fields: Record<string, FieldDefinition>
  eventName: {
    separator: string
    minimumSegments: number
    firstCharacters: string
    followingCharacters: string
  }
}

const LOG_SCHEMA = schemaSource as LogSchema
export const LOG_SCHEMA_VERSION = LOG_SCHEMA.version
export const LOG_LEVELS = Object.freeze([...(LOG_SCHEMA.fields.level.values ?? [])])
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface LogSchemaValidation {
  valid: boolean
  reason?: string
}

/** 按共享声明检查事件名，不在适配器里另存一份文法。 */
export function isValidLogEventName(event: string): boolean {
  const { separator, minimumSegments, firstCharacters, followingCharacters } = LOG_SCHEMA.eventName
  const segments = event.split(separator)
  return segments.length >= minimumSegments && segments.every(segment => {
    if (!segment || !firstCharacters.includes(segment[0])) return false
    for (const character of segment.slice(1)) {
      if (!followingCharacters.includes(character)) return false
    }
    return true
  })
}

/** 校验运行时输入的完整顶层形状；嵌套错误和上下文由其自身适配器处理。 */
export function validateLogEntry(value: unknown): LogSchemaValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: '条目必须是对象' }
  }

  const entry = value as Record<string, unknown>
  const fields = LOG_SCHEMA.fields
  if (LOG_SCHEMA.unknownFields === 'reject') {
    const unknown = Object.keys(entry).find(key => !Object.prototype.hasOwnProperty.call(fields, key))
    if (unknown) return { valid: false, reason: `未知字段 ${unknown}` }
  }

  for (const [name, field] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(entry, name)) {
      if (field.required) return { valid: false, reason: `缺少必填字段 ${name}` }
      continue
    }

    const fieldValue = entry[name]
    if (fieldValue === null && field.nullable) continue

    const typeMatches = field.type === 'integer'
      ? typeof fieldValue === 'number' && Number.isInteger(fieldValue)
      : field.type === 'string'
        ? typeof fieldValue === 'string'
        : fieldValue !== null && typeof fieldValue === 'object' && !Array.isArray(fieldValue)
    if (!typeMatches) return { valid: false, reason: `字段 ${name} 类型不符` }

    if (name === LOG_SCHEMA.versionField && fieldValue !== LOG_SCHEMA.version) {
      return { valid: false, reason: `字段 ${name} 版本不符` }
    }
    if (field.nonBlank && typeof fieldValue === 'string' && fieldValue.trim().length === 0) {
      return { valid: false, reason: `字段 ${name} 不能为空白` }
    }
    if (field.values && (typeof fieldValue !== 'string' || !field.values.includes(fieldValue))) {
      return { valid: false, reason: `字段 ${name} 不在允许值内` }
    }
    if (field.format === 'eventName' && (typeof fieldValue !== 'string' || !isValidLogEventName(fieldValue))) {
      return { valid: false, reason: `字段 ${name} 文法不符` }
    }
  }

  return { valid: true }
}

export function isValidLogEntry(value: unknown): boolean {
  return validateLogEntry(value).valid
}
