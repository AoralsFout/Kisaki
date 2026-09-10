import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = join(process.cwd(), 'src')
const DOMAIN_ROOT = join(SOURCE_ROOT, 'domain')
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
    else if (['.ts', '.tsx'].includes(extname(entry.name)) && !entry.name.endsWith('.test.ts')) files.push(path)
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
})
