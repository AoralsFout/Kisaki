/**
 * 结构化日志系统单元测试
 *
 * 覆盖：
 * - getBuffer / clearBuffer 环形缓冲区
 * - setLogLevel / getLogLevel 级别过滤
 * - resetConfig / getConfig 配置管理
 * - createLogger 日志创建与输出
 * - subscribe 订阅者机制
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// 注意：logger 模块有模块级状态（全局变量），
// 在每个测试文件内重置状态以避免跨测试污染

describe('Logger - 配置管理', () => {
  beforeEach(() => {
    // 重置模块状态: 动态导入后重置
  })

  it('setLogLevel / getLogLevel', async () => {
    const mod = await import('../logger')
    mod.setLogLevel('error')
    expect(mod.getLogLevel()).toBe('error')

    mod.setLogLevel('trace')
    expect(mod.getLogLevel()).toBe('trace')

    mod.setLogLevel('info')
    expect(mod.getLogLevel()).toBe('info')
  })

  it('getConfig 返回只读快照', async () => {
    const mod = await import('../logger')
    mod.resetConfig()
    const cfg = mod.getConfig()
    expect(cfg).toHaveProperty('minLevel')
    expect(cfg).toHaveProperty('enabled')
    expect(cfg).toHaveProperty('bufferSize')

    // 修改返回的快照不应影响内部状态
    cfg.minLevel = 'error'
    expect(mod.getConfig().minLevel).not.toBe('error')
  })

  it('resetConfig 恢复默认配置并清空缓冲区', async () => {
    const mod = await import('../logger')
    mod.setLogLevel('error')
    expect(mod.getLogLevel()).toBe('error')

    mod.resetConfig()
    // 重置后应为默认值: PROD 环境为 info，DEV 为 debug
    // vitest 中 import.meta.env.PROD 为 false，所以默认为 'debug'
    expect(mod.getLogLevel()).toBe('debug')
    expect(mod.getBuffer()).toEqual([])
  })
})

describe('Logger - 环形缓冲区', () => {
  beforeEach(async () => {
    const mod = await import('../logger')
    mod.resetConfig()
  })

  it('初始缓冲区为空', async () => {
    const mod = await import('../logger')
    expect(mod.getBuffer()).toEqual([])
  })

  it('clearBuffer 清空缓冲区', async () => {
    const mod = await import('../logger')
    // 写入一条日志
    const log = mod.createLogger('Test')
    log.info("test.module.info", "hello")
    expect(mod.getBuffer().length).toBeGreaterThan(0)

    mod.clearBuffer()
    expect(mod.getBuffer()).toEqual([])
  })

  it('getBuffer 返回按时间正序的日志', async () => {
    const mod = await import('../logger')
    mod.clearBuffer()
    const log = mod.createLogger('Test')
    log.info("test.module.info", "first")
    log.warn("test.module.warn", "second")
    log.error("test.module.error", "third", new Error("third"))

    const buf = mod.getBuffer()
    expect(buf.length).toBe(3)
    expect(buf[0].message).toBe('first')
    expect(buf[1].message).toBe('second')
    expect(buf[2].message).toBe('third')
    // 验证级别正确
    expect(buf.map(e => e.level)).toEqual(['info', 'warn', 'error'])
  })

  it('日志条目包含必要字段', async () => {
    const mod = await import('../logger')
    mod.clearBuffer()
    const log = mod.createLogger('MyModule')
    log.info("test.module.info", "测试消息")

    const buf = mod.getBuffer()
    expect(buf.length).toBe(1)
    const entry = buf[0]
    expect(entry).toHaveProperty('timestamp')
    expect(entry).toHaveProperty('level', 'info')
    expect(entry).toHaveProperty('namespace', 'MyModule')
    expect(entry).toHaveProperty('message', '测试消息')
    expect(entry).toHaveProperty('source')
    // timestamp 应为 ISO 格式
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('日志携带结构化上下文', async () => {
    const mod = await import('../logger')
    mod.clearBuffer()
    const log = mod.createLogger('ArgsTest')
    log.info("test.module.info", `计数: ${42}`, { value1: 42, key: { key: 'val' } })

    const buf = mod.getBuffer()
    expect(buf.length).toBe(1)
    expect(buf[0].context).toEqual({ value1: 42, key: { key: 'val' } })
  })
})

describe('Logger - 级别过滤', () => {
  beforeEach(async () => {
    const mod = await import('../logger')
    mod.resetConfig()
  })

  it('低于全局级别的日志不进入缓冲区', async () => {
    const mod = await import('../logger')
    mod.setLogLevel('warn')
    mod.clearBuffer()

    const log = mod.createLogger('FilterTest')
    log.trace("test.module.trace", "不应出现")
    log.debug("test.module.debug", "不应出现")
    log.info("test.module.info", "不应出现")

    expect(mod.getBuffer().length).toBe(0)

    log.warn("test.module.warn", "应出现")
    log.error("test.module.error", "应出现", new Error("应出现"))
    expect(mod.getBuffer().length).toBe(2)
  })

  it('Logger 级别覆盖全局级别（更严格）', async () => {
    const mod = await import('../logger')
    mod.setLogLevel('trace')
    mod.clearBuffer()

    // 创建 Logger 时指定只输出 warn 及以上
    const log = mod.createLogger('Strict', 'warn')
    log.info("test.module.info", "不应出现")
    log.warn("test.module.warn", "应出现")
    log.error("test.module.error", "应出现", new Error("应出现"))

    expect(mod.getBuffer().length).toBe(2)
    expect(mod.getBuffer()[0].level).toBe('warn')
    expect(mod.getBuffer()[1].level).toBe('error')
  })

  it('全局 enabled=false 时全部静默', async () => {
    const mod = await import('../logger')
    mod.resetConfig()
    mod.setLogEnabled(false)
    const log = mod.createLogger('DisabledTest')
    log.info("test.module.info", "消息1")
    expect(mod.getBuffer()).toEqual([])
  })
})

describe('Logger - 订阅者机制', () => {
  beforeEach(async () => {
    const mod = await import('../logger')
    mod.resetConfig()
  })

  it('subscribe 接收到新日志回调', async () => {
    const mod = await import('../logger')
    mod.clearBuffer()
    const callback = vi.fn()
    const unsubscribe = mod.subscribe(callback)

    const log = mod.createLogger('SubTest')
    log.info("test.module.info", "订阅测试")

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        namespace: 'SubTest',
        message: '订阅测试',
      }),
    )

    unsubscribe()
  })

  it('unsubscribe 停止接收回调', async () => {
    const mod = await import('../logger')
    mod.clearBuffer()
    const callback = vi.fn()
    const unsubscribe = mod.subscribe(callback)
    unsubscribe()

    const log = mod.createLogger('UnsubTest')
    log.info("test.module.info", "取消后消息")

    expect(callback).not.toHaveBeenCalled()
  })

  it('多个订阅者各自收到相同日志', async () => {
    const mod = await import('../logger')
    mod.clearBuffer()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    mod.subscribe(cb1)
    mod.subscribe(cb2)

    const log = mod.createLogger('MultiSub')
    log.info("test.module.info", "多订阅者")

    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
  })
})

describe('Logger - 日志级别完整输出', () => {
  beforeEach(async () => {
    const mod = await import('../logger')
    mod.resetConfig()
  })

  it('支持所有五个日志级别', async () => {
    const mod = await import('../logger')
    mod.setLogLevel('trace')
    mod.clearBuffer()

    const log = mod.createLogger('AllLevels')
    log.trace("test.module.trace", "trace msg")
    log.debug("test.module.debug", "debug msg")
    log.info("test.module.info", "info msg")
    log.warn("test.module.warn", "warn msg")
    log.error("test.module.error", "error msg", new Error("error msg"))

    expect(mod.getBuffer().length).toBe(5)
    expect(mod.getBuffer().map(e => e.level)).toEqual([
      'trace', 'debug', 'info', 'warn', 'error',
    ])
  })

  it('Logger 对象包含 ns 属性', async () => {
    const mod = await import('../logger')
    const log = mod.createLogger('MyNamespace')
    expect(log.ns).toBe('MyNamespace')
  })

  it('不同命名空间各自独立着色', async () => {
    const mod = await import('../logger')
    const log1 = mod.createLogger('AAA')
    const log2 = mod.createLogger('BBB')
    // ns 属性应正确
    expect(log1.ns).toBe('AAA')
    expect(log2.ns).toBe('BBB')
  })
})

describe('Logger - 持久化控制', () => {
  beforeEach(async () => {
    const mod = await import('../logger')
    mod.resetConfig()
  })

  it('disableFilePersistence 可安全调用', async () => {
    const mod = await import('../logger')
    // 不应抛出异常
    expect(() => mod.disableFilePersistence()).not.toThrow()
  })

  it('enableFilePersistence 在非 Tauri 环境静默降级', async () => {
    const mod = await import('../logger')
    // 非 Tauri 环境下，不会抛出异常
    await expect(mod.enableFilePersistence()).resolves.not.toThrow()
  })

  it('异常、堆栈、事件和上下文会完整持久化', async () => {
    const mod = await import('../logger')
    invokeMock.mockResolvedValue(undefined)
    await mod.enableFilePersistence()

    const cause = new Error('底层连接失败')
    const error = new Error('请求失败') as Error & { code?: string; cause?: unknown }
    error.cause = cause
    error.code = 'ECONNRESET'
    const log = mod.createLogger('PersistTest')
    log.error("ai.request_failed", "调用模型失败", error, {
      requestId: 'req-1',
      apiKey: 'sk-should-not-leak',
    })
    await mod.flushLogs()

    expect(invokeMock).toHaveBeenCalledWith('append_log_entries', expect.objectContaining({
      entries: [expect.objectContaining({
        event: 'ai.request_failed',
        error: expect.objectContaining({
          name: 'Error',
          message: '请求失败',
          code: 'ECONNRESET',
          stack: expect.any(String),
          cause: expect.objectContaining({ message: '底层连接失败' }),
        }),
        context: { requestId: 'req-1', apiKey: '[REDACTED]' },
      })],
    }))
  })

  it('落盘失败时保留队列并暴露健康状态', async () => {
    const mod = await import('../logger')
    invokeMock.mockRejectedValue(new Error('disk full'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await mod.enableFilePersistence()

    mod.createLogger('PersistTest').error('logger.write_failed', '不能丢失', new Error('disk full'))
    await mod.flushLogs()

    expect(mod.getPersistenceStatus()).toEqual(expect.objectContaining({
      enabled: true,
      pending: 1,
      failures: 1,
      dropped: 0,
      lastError: expect.objectContaining({ message: 'disk full' }),
    }))
  })
})

describe('Logger - 异常序列化', () => {
  beforeEach(async () => {
    const mod = await import('../logger')
    mod.resetConfig()
    invokeMock.mockReset()
    vi.restoreAllMocks()
  })

  it('error 调用保留强制传入的 Error 对象', async () => {
    const mod = await import('../logger')
    const error = new TypeError('字段不存在')
    mod.createLogger('AutoError').error('processing.failed', '处理失败', error)

    expect(mod.getBuffer()[0].error).toEqual(expect.objectContaining({
      name: 'TypeError',
      message: '字段不存在',
      stack: expect.any(String),
    }))
  })

  it('结构化事件保留事件名与上下文', async () => {
    const mod = await import('../logger')
    mod.createLogger('Events').info('request.started', '请求开始', { requestId: 'req-1' })

    expect(mod.getBuffer()[0]).toEqual(expect.objectContaining({
      event: 'request.started',
      context: { requestId: 'req-1' },
    }))
  })

  it('记录违规会生成脱敏的 warn 诊断并进入常规日志出口', async () => {
    const mod = await import('../logger')
    mod.resetConfig()
    mod.setLogLevel('error')
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    await mod.enableFilePersistence()
    invokeMock.mockClear()

    const consoleWarning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broadcast = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
    const callback = vi.fn()
    const unsubscribe = mod.subscribe(callback)
    const log = mod.createLogger('Events')

    expect(() => log.info(
      'Request.Started',
      'Authorization: Bearer abc.def-123 at C:\\Users\\Alice\\secret.txt',
      { apiKey: 'sk-private-secret' },
    )).not.toThrow()
    await mod.flushLogs()

    expect(mod.getBuffer()).toEqual([
      expect.objectContaining({
        level: 'warn',
        namespace: 'Logger',
        event: 'logger.record_invalid',
        message: expect.stringContaining('event'),
        context: expect.objectContaining({
          attemptedNamespace: 'Events',
          attemptedLevel: 'info',
          inputTruncated: false,
        }),
      }),
    ])
    const diagnostic = mod.getBuffer()[0]
    const safeInput = diagnostic.context?.input as string
    expect(safeInput).toContain('Request.Started')
    expect(safeInput).toContain('[REDACTED]')
    expect(safeInput).toContain('[PATH]')
    expect(safeInput).not.toContain('abc.def-123')
    expect(safeInput).not.toContain('sk-private-secret')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(diagnostic)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith(diagnostic)
    expect(invokeMock).toHaveBeenCalledWith('append_log_entries', expect.objectContaining({
      entries: [expect.objectContaining({ event: 'logger.record_invalid', level: 'warn' })],
    }))
    expect(consoleWarning).toHaveBeenCalledWith(
      '[Logger] 已拒绝不符合日志 v2 契约的记录',
      diagnostic,
    )

    unsubscribe()
    consoleWarning.mockRestore()
    broadcast.mockRestore()
  })

  it('脱敏序列化后的二次校验失败也会报告合法诊断', async () => {
    const mod = await import('../logger')
    mod.resetConfig()
    const log = mod.createLogger('Events')

    expect(() => log.info('request.started', '请求开始', new Date() as never)).not.toThrow()

    expect(mod.getBuffer()).toEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'logger.record_invalid',
        message: expect.stringContaining('context'),
        context: expect.objectContaining({ inputTruncated: false }),
      }),
    ])
  })

  it('全局日志关闭时不产生违规诊断或文件记录', async () => {
    const mod = await import('../logger')
    mod.resetConfig()
    mod.setLogEnabled(false)
    invokeMock.mockReset()
    await mod.enableFilePersistence()
    const consoleWarning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => mod.createLogger('Events').info('Request.Started', '不合法事件')).not.toThrow()
    await mod.flushLogs()

    expect(mod.getBuffer()).toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
    expect(consoleWarning).not.toHaveBeenCalled()
    consoleWarning.mockRestore()
  })

  it('fatal 记录违规时仍返回等待落盘的 Promise', async () => {
    const mod = await import('../logger')
    mod.resetConfig()
    invokeMock.mockReset()
    await mod.enableFilePersistence()

    let releaseWrite!: () => void
    invokeMock.mockImplementation(() => new Promise<void>(resolve => { releaseWrite = resolve }))
    const fatal = mod.createLogger('Events').fatal('Request.Started', '致命日志违规', new Error('bad event'))
    expect(fatal).toBeInstanceOf(Promise)

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'append_log_entries',
      expect.objectContaining({ entries: [expect.objectContaining({ event: 'logger.record_invalid' })] }),
    ))
    let completed = false
    void fatal.then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)

    releaseWrite()
    await expect(fatal).resolves.toBeUndefined()
  })

  it('循环对象和嵌套敏感字段可安全处理', async () => {
    const mod = await import('../logger')
    const details: Record<string, unknown> = { authorization: 'Bearer secret-token' }
    details.self = details
    const normalized = mod.normalizeError({ message: '失败', details })
    const text = JSON.stringify(normalized)

    expect(text).toContain('[REDACTED]')
    expect(text).toContain('[Circular]')
    expect(text).not.toContain('secret-token')
  })
})

describe('Logger - 敏感信息脱敏', () => {
  it('敏感诊断默认关闭，显式开启后不受生产日志级别过滤', async () => {
    const mod = await import('../logger')
    mod.resetConfig()
    mod.setLogLevel('info')
    mod.setSensitiveDiagnosticsEnabled(false)
    const log = mod.createLogger('Sensitive')

    log.sensitiveDebug('test.sensitive_debug', 'secret detail')
    expect(mod.getBuffer()).toHaveLength(0)

    mod.setSensitiveDiagnosticsEnabled(true)
    log.sensitiveDebug('test.sensitive_debug', 'secret detail')
    expect(mod.getBuffer()).toHaveLength(1)
    mod.setSensitiveDiagnosticsEnabled(false)
  })

  it('移除常见 API Key 和 Authorization 值', async () => {
    const { redactSensitiveText } = await import('../logger')
    const input = 'apiKey=sk-secret123 Authorization: Bearer abc.def-123 access_token=token-value'
    const output = redactSensitiveText(input)

    expect(output).not.toContain('sk-secret123')
    expect(output).not.toContain('abc.def-123')
    expect(output).not.toContain('token-value')
    expect(output).toContain('[REDACTED]')
  })

  it('保留普通日志内容', async () => {
    const { redactSensitiveText } = await import('../logger')
    expect(redactSensitiveText('request completed in 42ms')).toBe('request completed in 42ms')
  })

  it('脱敏含空格的盘符路径和 UNC 路径', async () => {
    const { redactSensitiveText } = await import('../logger')
    const output = redactSensitiveText('C:\\Users\\Alice Smith\\secret.txt and \\\\server\\private share\\report.docx')
    expect(output).not.toContain('Alice Smith')
    expect(output).not.toContain('server')
    expect(output).not.toContain('private share')
    expect(output).toContain('[PATH]')
  })

  it('安全展示历史解析失败内容并标出截断长度', async () => {
    const { prepareParseFailureForDisplay } = await import('../logger')
    const raw = 'not JSON; Authorization: Bearer abc.def-123; path=C:\\Users\\Alice Smith\\secret.txt'
    const prepared = prepareParseFailureForDisplay(`[日志解析失败] ${raw}`)

    expect(prepared.message).toContain('not JSON')
    expect(prepared.message).not.toContain('abc.def-123')
    expect(prepared.message).not.toContain('Alice Smith')
    expect(prepared.message).toContain('[REDACTED]')
    expect(prepared.message).toContain('[PATH]')
    expect(prepared.truncated).toBe(false)

    const longRaw = `${'排查说明'.repeat(1400)}; ${raw}`
    const longPrepared = prepareParseFailureForDisplay(`[日志解析失败] ${longRaw}`)
    expect(longPrepared.truncated).toBe(true)
    expect(longPrepared.originalLength).toBe([...longRaw].length)
    expect([...longPrepared.message.slice('[日志解析失败] '.length)]).toHaveLength(4096)
  })
})

describe('Logger - 敏感诊断开关', () => {
  beforeEach(async () => {
    const mod = await import('../logger')
    mod.resetConfig()
    mod.setSensitiveDiagnosticsEnabled(false)
    mod.clearBuffer()
    localStorage.clear()
  })

  it('关闭时不记录敏感调试日志', async () => {
    const mod = await import('../logger')
    mod.setLogLevel('trace')
    mod.createLogger('SensitiveOff').sensitiveDebug('sensitive.test.debug', '敏感内容', { text: 'secret' })

    expect(mod.getBuffer()).toEqual([])
  })

  it('开启后可绕过较高的全局日志级别写入敏感调试日志', async () => {
    const mod = await import('../logger')
    mod.setLogLevel('error')
    mod.setSensitiveDiagnosticsEnabled(true)
    mod.createLogger('SensitiveOn').sensitiveDebug('sensitive.test.debug', '敏感内容', { text: 'secret' })

    expect(mod.getBuffer()).toEqual([
      expect.objectContaining({
        level: 'debug',
        event: 'sensitive.test.debug',
        context: { text: 'secret' },
      }),
    ])
  })
})
