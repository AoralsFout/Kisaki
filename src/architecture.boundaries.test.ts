import { readFileSync, readdirSync } from 'node:fs'
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
    expect(source).toContain('new ConversationCoordinator()')
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
    expect(source.match(/triggerTts\(/g)).toHaveLength(2) // one event subscriber + function declaration
    expect(source.match(/isProcessing\.value\s*=/g)).toHaveLength(1)
    expect(source.match(/isUsingTools\.value\s*=/g)).toHaveLength(1)
  })
})
