import { describe, expect, it } from 'vitest'
import samples from '../../../shared/log-schema-v2-samples.json'
import { isValidLogEntry, LOG_LEVELS, LOG_SCHEMA_VERSION } from '../logSchema'

describe('共享日志 v2 契约', () => {
  it('按共享样例判断有效与无效条目', () => {
    for (const sample of samples) {
      expect(isValidLogEntry(sample.entry), sample.name).toBe(sample.valid)
    }
  })

  it('从声明读取版本和级别', () => {
    expect(LOG_SCHEMA_VERSION).toBe(2)
    expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error'])
  })
})
