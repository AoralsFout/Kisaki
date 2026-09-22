import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = join(process.cwd(), 'src')
const DOMAIN_ROOT = join(SOURCE_ROOT, 'domain')
const AGENT_ROOT = join(SOURCE_ROOT, 'agent')
const APPLICATION_ROOT = join(SOURCE_ROOT, 'application')
const AI_ROOT = join(SOURCE_ROOT, 'ai')
const FORBIDDEN_DOMAIN_IMPORTS = [
  'vue',
  'pinia',
  '@tauri-apps/',
  '/stores/',
  '/components/',
  '/infrastructure/',
  '/presentation/',
]

function sourceFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (['.ts', '.tsx', '.vue'].includes(extname(entry.name)) && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

function importsOf(source: string): string[] {
  const specifiers = [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'\"]+?\s+from\s+)?['\"]([^'\"]+)['\"]/g)]
    .map(match => match[1])
  // 动态 import() 没有 from 子句，上面那条正则要求 import 后跟空白，扫不到它；
  // 少了这一遍，`await import('pinia')` 就能绕过全部规则。
  for (const match of source.matchAll(/\bimport\s*\(\s*['\"]([^'\"]+)['\"]/g)) specifiers.push(match[1])
  return specifiers
}

type BoundaryLayer = 'tool' | 'application' | 'ai' | 'tool-contract'

/**
 * 把相对模块说明符解析为仓库内的层级路径。
 *
 * 架构规则只在这里按真实路径分类，不用 `source.includes('store')` 之类的
 * 关键词匹配；这样组合根和基础设施适配器可以合法读取 Store，而工具层不能。
 */
function localTarget(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const target = resolve(dirname(importer), specifier).replace(/\\/g, '/')
  return relative(SOURCE_ROOT, target).replace(/\\/g, '/')
}

function boundaryViolation(layer: BoundaryLayer, importer: string, specifier: string): string | null {
  const target = localTarget(importer, specifier)
  const normalizedSpecifier = specifier.toLowerCase()

  if (layer === 'tool' && target?.startsWith('stores/')) return '工具实现不得依赖界面 Store'
  if ((layer === 'application' || layer === 'ai') && target?.startsWith('agent/')) {
    return 'application/AI 不得依赖 Agent 具体实现'
  }
  if (layer === 'tool-contract') {
    if (
      target?.startsWith('agent/') ||
      target?.startsWith('application/') ||
      target?.startsWith('ai/') ||
      target?.startsWith('infrastructure/') ||
      target?.startsWith('stores/') ||
      target?.startsWith('components/') ||
      normalizedSpecifier === 'vue' ||
      normalizedSpecifier === 'pinia' ||
      normalizedSpecifier.startsWith('@tauri-apps/')
    ) return '共享工具契约不得反向依赖实现层、应用层或界面层'
  }
  return null
}

function boundaryViolations(layer: BoundaryLayer, importer: string, source: string): string[] {
  return importsOf(source)
    .map(specifier => {
      const reason = boundaryViolation(layer, importer, specifier)
      return reason ? `${relative(SOURCE_ROOT, importer)} -> ${specifier}: ${reason}` : null
    })
    .filter((violation): violation is string => violation !== null)
}

/**
 * 架构守卫只检查语法树中的标识符和成员调用，不把注释或字符串里的说明文字当成生产路径。
 * 这样新增日志、文档注释或错误文案时，不会误报为旧恢复 API 的重新引入。
 */
function syntaxTree(source: string): ts.SourceFile {
  return ts.createSourceFile('architecture-guard.ts', source, ts.ScriptTarget.Latest, true)
}

function identifiersOf(source: string): Set<string> {
  const identifiers = new Set<string>()
  const tree = syntaxTree(source)
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return identifiers
}

function accessPath(expression: ts.Expression): string | null {
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isIdentifier(expression)) return expression.text
  if (!ts.isPropertyAccessExpression(expression)) return null
  const parent = accessPath(expression.expression)
  return parent ? `${parent}.${expression.name.text}` : null
}

function memberCallsOf(source: string): string[] {
  const calls: string[] = []
  const tree = syntaxTree(source)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const path = accessPath(node.expression)
      if (path) calls.push(path)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return calls
}

describe('architecture boundaries', () => {
  it('keeps tool implementations away from UI stores', () => {
    const violations: string[] = []
    for (const file of sourceFiles(AGENT_ROOT)) {
      violations.push(...boundaryViolations('tool', file, readFileSync(file, 'utf8')))
    }
    expect(violations).toEqual([])
  })

  it('keeps application and AI layers away from concrete Agent implementations', () => {
    const violations: string[] = []
    for (const [layer, root] of [['application', APPLICATION_ROOT], ['ai', AI_ROOT]] as const) {
      for (const file of sourceFiles(root)) {
        violations.push(...boundaryViolations(layer, file, readFileSync(file, 'utf8')))
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps the shared tool contract independent from both sides of the boundary', () => {
    const violations: string[] = []
    const contractRoot = join(DOMAIN_ROOT, 'tools')
    for (const file of sourceFiles(contractRoot)) {
      violations.push(...boundaryViolations('tool-contract', file, readFileSync(file, 'utf8')))
    }
    expect(violations).toEqual([])
  })

  it('keeps execution policy and character behavior on the neutral tools port', () => {
    const policy = readFileSync(join(SOURCE_ROOT, 'agent', 'toolExecutionPolicy.ts'), 'utf8')
    expect(importsOf(policy).filter(specifier => specifier.includes('/application/'))).toEqual([])

    const contracts = readFileSync(join(DOMAIN_ROOT, 'tools', 'contracts.ts'), 'utf8')
    expect(contracts).not.toContain('ToolCharacterRuntimePort')
    expect(contracts).not.toMatch(/\b(?:setLook|setScreenPose|playMotion)\s*\(/)

    const ports = readFileSync(join(DOMAIN_ROOT, 'tools', 'ports.ts'), 'utf8')
    expect(ports).not.toContain('CharacterToolRuntimePort')
    expect(ports).toContain('ToolCharacterRuntimePort')
    expect(ports).not.toContain('/application/')
  })

  it('uses controlled violations to prove each boundary rule fails closed', () => {
    const toolFile = join(AGENT_ROOT, 'tools', 'controlled-violation.ts')
    const applicationFile = join(APPLICATION_ROOT, 'conversation', 'controlled-violation.ts')
    const aiFile = join(AI_ROOT, 'controlled-violation.ts')
    const contractFile = join(DOMAIN_ROOT, 'tools', 'controlled-violation.ts')

    expect(boundaryViolations(
      'tool',
      toolFile,
      "import { useChatStore } from '../../stores/chat'",
    )).toHaveLength(1)
    expect(boundaryViolations(
      'application',
      applicationFile,
      "import { readFileTool } from '../../agent/tools/files'",
    )).toHaveLength(1)
    expect(boundaryViolations(
      'ai',
      aiFile,
      "import { executeToolCall } from '../agent/executor'",
    )).toHaveLength(1)
    expect(boundaryViolations(
      'tool-contract',
      contractFile,
      "import { agentService } from '../../agent/service'",
    )).toHaveLength(1)
  })

  it('keeps the new domain layer independent from frameworks and adapters', () => {
    const violations: string[] = []
    for (const file of sourceFiles(DOMAIN_ROOT)) {
      const imports = importsOf(readFileSync(file, 'utf8'))
      for (const dependency of imports) {
        if (FORBIDDEN_DOMAIN_IMPORTS.some(forbidden => dependency.includes(forbidden))) {
          violations.push(`${relative(SOURCE_ROOT, file)} -> ${dependency}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps application services independent from UI, stores, and infrastructure', () => {
    const forbidden = [
      'vue',
      'pinia',
      '@tauri-apps/',
      '/stores/',
      '/components/',
      '/infrastructure/',
      '/presentation/',
    ]
    const violations: string[] = []
    for (const file of sourceFiles(APPLICATION_ROOT)) {
      const imports = importsOf(readFileSync(file, 'utf8'))
      for (const dependency of imports) {
        if (forbidden.some(candidate => dependency.includes(candidate))) {
          violations.push(`${relative(SOURCE_ROOT, file)} -> ${dependency}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps the ConversationSession round orchestrator free of framework dependencies', () => {
    // 这条缝是本次重构唯一新增的对外缝，值得一条具名的、可追溯的断言；
    // 其余越界（stores / components / infrastructure）由上面那条泛化规则覆盖。
    const source = readFileSync(
      join(SOURCE_ROOT, 'application', 'conversation', 'conversationSession.ts'),
      'utf8',
    )
    // importsOf 现在也返回动态 import() 的说明符，`await import('pinia')` 同样在此拦下。
    for (const forbidden of ['vue', 'pinia', '@tauri-apps/']) {
      expect(importsOf(source).filter(specifier => specifier.includes(forbidden))).toEqual([])
    }
  })

  it('does not allow ChatStore to import SessionStore', () => {
    const chatStore = join(SOURCE_ROOT, 'stores', 'chat.ts')
    expect(importsOf(readFileSync(chatStore, 'utf8'))).not.toContain('./session')
  })

  it('keeps SessionStore on the single v2 aggregate persistence path', () => {
    const source = readFileSync(join(SOURCE_ROOT, 'stores', 'session.ts'), 'utf8')
    // 仓储与服务的构造已上移到组合根；store 只剩下「消费装配结果」这一条路径，
    // 既选不了实现，也回不到旧版会话格式。正面的构造断言见下一条。
    expect(source).not.toContain('new SessionApplicationService(')
    expect(source).not.toContain('new TauriSessionRepository()')
    expect(source).not.toContain('new MemorySessionRepository()')
    expect(source).not.toContain("invoke('sessions_load'")
    expect(source).not.toContain("invoke('sessions_save'")
    expect(source).not.toContain('localStorage')
    expect(source).not.toContain('exportContext()')
    expect(source).not.toContain('saveCurrentSession')
    expect(source).not.toMatch(/session\.messages\s*=/)
    expect(source).not.toMatch(/session\.context\s*=/)
  })

  it('keeps model history out of protocol snapshot round trips', () => {
    const forbidden = ['exportSnapshot', 'importSnapshot', 'ChatContextSnapshot']
    const violations: string[] = []
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const identifiers = identifiersOf(readFileSync(file, 'utf8'))
      for (const name of forbidden) {
        if (identifiers.has(name)) violations.push(`${relative(SOURCE_ROOT, file)} -> ${name}`)
      }
    }
    expect(violations).toEqual([])

    const contextPath = join(SOURCE_ROOT, 'infrastructure', 'conversation', 'chatContextModelContext.ts')
    const context = readFileSync(contextPath, 'utf8')
    const calls = memberCallsOf(context)
    expect(calls).toContain('this.context.replaceHistory')
    expect(calls).toContain('this.context.inspect')
    for (const legacyCall of [
      'this.context.exportSnapshot',
      'this.context.importSnapshot',
      'this.context.restoreUserImages',
      'this.context.snapshot',
      'this.context.restore',
    ]) expect(calls).not.toContain(legacyCall)
  })

  it('keeps UI transcript separate from the timeline model-history projection', () => {
    const chat = readFileSync(join(SOURCE_ROOT, 'stores', 'chat.ts'), 'utf8')
    const session = readFileSync(join(SOURCE_ROOT, 'stores', 'session.ts'), 'utf8')
    const adapter = readFileSync(join(SOURCE_ROOT, 'infrastructure', 'conversation', 'chatContextModelContext.ts'), 'utf8')
    const chatCalls = memberCallsOf(chat)
    const sessionCalls = memberCallsOf(session)
    const adapterIdentifiers = identifiersOf(adapter)

    expect(chatCalls.filter(call => call === 'context.loadModelProjection')).toHaveLength(2)
    expect(chatCalls).not.toContain('context.restoreUserImages')
    expect(chatCalls).not.toContain('context.restore')
    expect(sessionCalls).toContain('aggregate.projectModelContext')
    expect(adapterIdentifiers).not.toContain('ConversationUserTurn')
    expect(adapterIdentifiers).not.toContain('restoreUserImages')
  })

  it('assembles the v2 session persistence path only in the composition root', () => {
    // 「真机持久化还是内存兜底」这个选择只允许出现在组合根；它同时是服务与两个仓储适配器
    // 的唯一构造点，SessionStore 通过注入的装配工厂消费结果。
    const root = readFileSync(join(SOURCE_ROOT, 'compositionRoot.ts'), 'utf8')
    expect(root).toContain('new SessionApplicationService(')
    expect(root).toContain('new TauriSessionRepository()')
    expect(root).toContain('new MemorySessionRepository()')
  })

  it('does not restore the legacy character controller registries', () => {
    const legacyModules = new Set([
      join(SOURCE_ROOT, 'character', 'commandBus'),
      join(SOURCE_ROOT, 'agent', 'context'),
    ].map(path => path.toLowerCase()))
    const violations: string[] = []

    for (const file of sourceFiles(SOURCE_ROOT)) {
      for (const dependency of importsOf(readFileSync(file, 'utf8'))) {
        if (!dependency.startsWith('.')) continue
        const resolved = resolve(dirname(file), dependency).toLowerCase()
        if (legacyModules.has(resolved)) violations.push(`${relative(SOURCE_ROOT, file)} -> ${dependency}`)
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps approval lifecycle and tool policy execution in the tool execution adapter', () => {
    // 批准生命周期与工具策略执行原先长在 ChatStore 里，随工具执行端口的适配器搬到了
    // 基础设施层；store 只剩「订阅待决状态 + 转发用户决策」。
    const store = readFileSync(join(SOURCE_ROOT, 'stores', 'chat.ts'), 'utf8')
    const factory = readFileSync(
      join(SOURCE_ROOT, 'infrastructure', 'conversation', 'toolExecutionCoordinatorFactory.ts'),
      'utf8',
    )
    expect(factory).toContain('new ToolExecutionCoordinator(')
    expect(store).not.toContain('new ToolExecutionCoordinator(')
    expect(store).not.toContain('new ApprovalGateway(')
    for (const legacy of [
      'confirmResolver',
      'commandConfirmResolver',
      'screenCaptureConfirmResolver',
      'waitUserConfirm(',
      'waitCommandConfirm(',
      'waitScreenCaptureConfirm(',
    ]) expect(store).not.toContain(legacy)
  })

  it('keeps conversation lifecycle and stream protocol parsing in ConversationSession', () => {
    // 回合编排整体搬到了 ConversationSession：ChatStore 不再认识状态机、流解码、
    // 工具批次与语音播放，只剩投影订阅与命令转发。
    const store = readFileSync(join(SOURCE_ROOT, 'stores', 'chat.ts'), 'utf8')
    const session = readFileSync(
      join(SOURCE_ROOT, 'application', 'conversation', 'conversationSession.ts'),
      'utf8',
    )
    for (const moved of [
      'new ConversationCoordinator(',
      'conversationCoordinator.runTurns(',
      'new ModelStreamDecoder()',
      'interpretModelTurn(',
      'new AssistantMessageCoordinator(',
      'conversationCoordinator.commitToolCalls(',
      'conversationCoordinator.commitToolResult(',
      'chatSessionPort.',
      'ttsPlaybackOrchestrator.',
    ]) expect(store).not.toContain(moved)
    expect(store).not.toContain('new AbortController()')
    expect(store).not.toContain('abortController ===')
    expect(store).not.toMatch(/for\s*\(let turn = 0;/)
    expect(store).not.toContain("result.type === 'done'")
    expect(store).not.toContain("result.type === 'tools'")
    expect(store).not.toContain('JSON.parse(tc.function.arguments')
    expect(store).not.toContain('function triggerTts(')
    expect(store).not.toContain('lastTtsText')
    expect(store).not.toContain('speakTextStreaming(')
    expect(store).not.toContain('cancelSpeak(')
    // 派生量各只有一个写入点：applyProjection 里的这两个赋值。
    expect(store.match(/isProcessing\.value\s*=/g)).toHaveLength(1)
    expect(store.match(/isUsingTools\.value\s*=/g)).toHaveLength(1)

    // 搬到新家之后，这些规则仍要被断言，只是换了文件。
    for (const owned of [
      'new ConversationCoordinator(',
      'this.coordinator.runTurns(',
      'new ModelStreamDecoder()',
      'interpretModelTurn(',
      'new AssistantMessageCoordinator(',
      'this.coordinator.commitToolCalls(',
      'this.coordinator.commitToolResult(',
      'this.ports.session.recordToolCalls(',
      'this.ports.session.recordToolResult(',
    ]) expect(session).toContain(owned)
    expect(session).not.toContain("result.type === 'done'")
    expect(session).not.toContain('JSON.parse(tc.function.arguments')
    // 语音不在这里直接播放：回合只把已提交的消息交给语音端口。
    expect(session).not.toContain('ttsPlaybackOrchestrator')
    expect(session).toContain('this.ports.voice.play(')
    // 原先对 ChatStore 的计数断言（工具调用/结果各写一次）随会话事实端口搬到新家：
    // 会话事实只有这一条写入路径，多一处就会打破「先落库再进模型上下文」的顺序。
    expect(session.match(/this\.ports\.session\.recordToolCalls\(/g)).toHaveLength(1)
    expect(session.match(/this\.ports\.session\.recordToolResult\(/g)).toHaveLength(1)
  })

  it('routes presentation playback through the TTS playback owner', () => {
    const violations: string[] = []
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const path = relative(SOURCE_ROOT, file).replace(/\\/g, '/')
      if (path.startsWith('tts/') || path.startsWith('application/tts/')) continue
      const source = readFileSync(file, 'utf8')
      if (/\b(?:speakTextStreaming|cancelSpeak)\s*\(/.test(source)) violations.push(path)
    }
    expect(violations).toEqual([])
  })

  it('keeps buffered provider protocols out of the central TTS engine', () => {
    const source = readFileSync(join(SOURCE_ROOT, 'tts', 'speak.ts'), 'utf8')
    expect(source).toContain('provider.synthesize(')
    expect(source).not.toContain('synthesizeWithGptSoVits(')
    expect(source).not.toMatch(/invoke<[^>]+>\('cosyvoice_tts'/)
    expect(source).not.toContain('getGptSoVitsCharacterParams')
  })

  it('keeps buffered audio playback behind sink ports', () => {
    const engine = readFileSync(join(SOURCE_ROOT, 'tts', 'speak.ts'), 'utf8')
    expect(engine).toContain('selectAudioSink(')
    expect(engine).not.toContain('playAudioBlob(')
    expect(engine).not.toContain('URL.createObjectURL(source.blob)')

    const gptSoVits = readFileSync(join(SOURCE_ROOT, 'tts', 'gptsovits.ts'), 'utf8')
    expect(gptSoVits).not.toContain('export function playAudioBlob(')

    for (const directory of ['sinks', 'streams', 'providers']) {
      const files = sourceFiles(join(SOURCE_ROOT, 'tts', directory))
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        const source = readFileSync(file, 'utf8')
        expect(source).not.toContain('/stores/')
        expect(source).not.toMatch(/from 'pinia'/)
      }
    }
  })

  it('keeps streaming transport and playback out of the TTS engine', () => {
    const engine = readFileSync(join(SOURCE_ROOT, 'tts', 'speak.ts'), 'utf8')
    expect(engine).toContain('findAudioSink(')
    expect(engine).not.toContain('new MediaSource(')
    expect(engine).not.toContain('addSourceBuffer')
    expect(engine).not.toContain('SourceBuffer')
    expect(engine).not.toContain('new Audio(')
    expect(engine).not.toContain('atob(')
    expect(engine).not.toContain('listen(')
    expect(engine).not.toContain('tts-audio-chunk')

    // 只有请求级通道适配器可以直接碰 Tauri Channel。
    const channelAdapter = readFileSync(join(SOURCE_ROOT, 'tts', 'streams', 'tauriChunkChannel.ts'), 'utf8')
    expect(channelAdapter).toContain('new Channel<TtsChunkPayload>()')
    const channelStream = readFileSync(join(SOURCE_ROOT, 'tts', 'streams', 'channelAudioStream.ts'), 'utf8')
    expect(channelStream).not.toContain('@tauri-apps/')
  })

  it('replaces the global TTS audio event with a request-scoped channel', () => {
    const rustTts = readFileSync(join(process.cwd(), 'src-tauri', 'src', 'tts.rs'), 'utf8')
    expect(rustTts).not.toContain('tts-audio-chunk')
    expect(rustTts).toContain('Channel<TtsChunk>')
  })

  it('keeps cross-window configuration listening in a single adapter', () => {
    const violations: string[] = []
    for (const file of sourceFiles(SOURCE_ROOT)) {
      if (file.endsWith(join('infrastructure', 'settings', 'localSettingsStore.ts'))) continue
      const source = readFileSync(file, 'utf8')
      if (/addEventListener\(\s*'storage'/.test(source)) violations.push(relative(SOURCE_ROOT, file))
    }
    expect(violations).toEqual([])
  })

  it('keeps secret-backed settings on the shared repository', () => {
    for (const relativePath of ['ai/client.ts', 'tts/config.ts', 'agent/tools/searchConfig.ts']) {
      const source = readFileSync(join(SOURCE_ROOT, ...relativePath.split('/')), 'utf8')
      expect(source).toContain('SecretBackedSettings')
      expect(source).not.toContain('localStorage.getItem')
      expect(source).not.toContain('localStorage.setItem')
      expect(source).not.toContain('persistSecret(')
      expect(source).not.toContain('resolveSecret(')
      expect(source).not.toContain('keychainDelete(')
    }
  })

  it('keeps outbound request policy in the shared executor', () => {
    const executor = readFileSync(join(SOURCE_ROOT, 'application', 'net', 'requestExecutor.ts'), 'utf8')
    expect(executor).toContain('combineAbortSignals')
    expect(executor).toContain('maxAttempts')

    // 业务层不得再自行实现超时/重试/传输选择
    for (const relativePath of ['ai/client.ts', 'agent/tools/searchHttp.ts']) {
      const source = readFileSync(join(SOURCE_ROOT, ...relativePath.split('/')), 'utf8')
      expect(source).toMatch(/\b(?:requestExecutor|executor)\.run/)
      expect(source).not.toContain('AbortSignal.timeout')
      expect(source).not.toMatch(/for \(let attempt/)
    }

    // SSE 帧解析属于传输层：业务客户端不得自行解码流
    const aiClient = readFileSync(join(SOURCE_ROOT, 'ai', 'client.ts'), 'utf8')
    expect(aiClient).toContain('readServerSentEvents(')
    expect(aiClient).not.toContain('TextDecoder')

    expect(existsSync(join(SOURCE_ROOT, 'ai', 'apiClient.ts'))).toBe(false)
  })

  it('installs cross-module services only from the composition root', () => {
    // 工具注册只能在组合根触发，模块加载不得再顺手注册
    const violations: string[] = []
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const path = relative(SOURCE_ROOT, file).replace(/\\/g, '/')
      const source = readFileSync(file, 'utf8')
      // agent/index.ts 只是定义，组合根是唯一的调用点
      if (/\binitTools\(\)/.test(source) && path !== 'agent/index.ts' && path !== 'compositionRoot.ts') {
        violations.push(path)
      }
      if (path !== 'infrastructure/settings/localSettingsStore.ts'
        && /addEventListener\(\s*'storage'/.test(source)) {
        violations.push(`${path}:storage-listener`)
      }
    }
    expect(violations).toEqual([])

    const root = readFileSync(join(SOURCE_ROOT, 'compositionRoot.ts'), 'utf8')
    for (const installer of [
      'initTools()',
      'installLocalSettingsBridge()',
      'installMotionPreferenceSync()',
      'installTtsPlaybackTelemetry()',
    ]) {
      expect(root).toContain(installer)
    }
  })

  it('keeps the TTS engine surface limited to what callers use', () => {
    const engine = readFileSync(join(SOURCE_ROOT, 'tts', 'speak.ts'), 'utf8')
    // 批次播放只剩内部回退路径；对外只保留流式入口
    expect(engine).not.toContain('async speakText(')
    expect(engine).not.toContain('isSpeaking(')
    expect(engine).not.toContain('export function cancelSpeak(')

    const voices = ['speakText', 'speakTextStreaming', 'cancelSpeak', 'isSpeaking']
    const index = readFileSync(join(SOURCE_ROOT, 'tts', 'index.ts'), 'utf8')
    for (const name of voices) expect(index).not.toContain(name)
  })
})
