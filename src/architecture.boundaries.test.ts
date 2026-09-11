import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = join(process.cwd(), 'src')
const DOMAIN_ROOT = join(SOURCE_ROOT, 'domain')
const APPLICATION_ROOT = join(SOURCE_ROOT, 'application')
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
  return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'\"]+?\s+from\s+)?['\"]([^'\"]+)['\"]/g)]
    .map(match => match[1])
}

describe('architecture boundaries', () => {
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

  it('does not allow ChatStore to import SessionStore', () => {
    const chatStore = join(SOURCE_ROOT, 'stores', 'chat.ts')
    expect(importsOf(readFileSync(chatStore, 'utf8'))).not.toContain('./session')
  })

  it('keeps SessionStore on the single v2 aggregate persistence path', () => {
    const source = readFileSync(join(SOURCE_ROOT, 'stores', 'session.ts'), 'utf8')
    expect(source).toContain('new SessionApplicationService(')
    expect(source).toContain('new TauriSessionRepository()')
    expect(source).not.toContain("invoke('sessions_load'")
    expect(source).not.toContain("invoke('sessions_save'")
    expect(source).not.toContain('localStorage')
    expect(source).not.toContain('exportContext()')
    expect(source).not.toContain('saveCurrentSession')
    expect(source).not.toMatch(/session\.messages\s*=/)
    expect(source).not.toMatch(/session\.context\s*=/)
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

  it('keeps approval lifecycle and tool policy execution outside ChatStore', () => {
    const source = readFileSync(join(SOURCE_ROOT, 'stores', 'chat.ts'), 'utf8')
    expect(source).toContain('new ToolExecutionCoordinator(')
    for (const legacy of [
      'confirmResolver',
      'commandConfirmResolver',
      'screenCaptureConfirmResolver',
      'waitUserConfirm(',
      'waitCommandConfirm(',
      'waitScreenCaptureConfirm(',
    ]) expect(source).not.toContain(legacy)
  })

  it('keeps conversation lifecycle and stream protocol parsing outside ChatStore', () => {
    const source = readFileSync(join(SOURCE_ROOT, 'stores', 'chat.ts'), 'utf8')
    expect(source).toContain('new ConversationCoordinator(')
    expect(source).toContain('conversationCoordinator.runTurns(')
    expect(source).toContain('new ModelStreamDecoder()')
    expect(source).toContain('interpretModelTurn(')
    expect(source).toContain('new AssistantMessageCoordinator(')
    expect(source).not.toContain('new AbortController()')
    expect(source).not.toContain('abortController ===')
    expect(source).not.toMatch(/for\s*\(let turn = 0;/)
    expect(source).not.toContain("result.type === 'done'")
    expect(source).not.toContain("result.type === 'tools'")
    expect(source).not.toContain('JSON.parse(tc.function.arguments')
    expect(source).toContain('conversationCoordinator.commitToolCalls(')
    expect(source).toContain('conversationCoordinator.commitToolResult(')
    // The sole direct references are dependency adapters passed into the coordinator.
    expect(source.match(/chatSessionPort\.recordToolCalls\(/g)).toHaveLength(1)
    expect(source.match(/chatSessionPort\.recordToolResult\(/g)).toHaveLength(1)
    expect(source).toContain('ttsPlaybackOrchestrator.play(')
    expect(source).not.toContain('function triggerTts(')
    expect(source).not.toContain('lastTtsText')
    expect(source).not.toContain('speakTextStreaming(')
    expect(source).not.toContain('cancelSpeak(')
    expect(source.match(/isProcessing\.value\s*=/g)).toHaveLength(1)
    expect(source.match(/isUsingTools\.value\s*=/g)).toHaveLength(1)
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
})
