import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const sourceRoot = join(projectRoot, 'src')
const loggerFile = join(sourceRoot, 'utils', 'logger.ts')
const sourceExtensions = new Set(['.ts', '.vue'])

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return sourceExtensions.has(extname(entry.name)) ? [path] : []
  })
}

function violations(pattern, { exclude = [] } = {}) {
  return sourceFiles(sourceRoot).flatMap(path => {
    if (exclude.includes(path)) return []
    return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line, index) =>
      pattern.test(line)
        ? [`${relative(projectRoot, path)}:${index + 1}: ${line.trim()}`]
        : [],
    )
  })
}

function eventNameViolations() {
  const eventPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
  const callPattern = /\blog\.(?:trace|debug|info|warn|error|fatal)\s*\(/g
  const problems = []
  for (const path of sourceFiles(sourceRoot)) {
    if (path === loggerFile || path.includes(`${join('src', 'utils', '__tests__')}`) || path.endsWith('.test.ts')) continue
    const source = readFileSync(path, 'utf8')
    for (const call of source.matchAll(callPattern)) {
      const lineStart = source.lastIndexOf('\n', call.index ?? 0) + 1
      const prefix = source.slice(lineStart, call.index).trimStart()
      if (prefix.startsWith('//') || prefix.startsWith('*')) continue
      const argument = source.slice((call.index ?? 0) + call[0].length).match(/^\s*(['"])([^'"]*)\1/)
      const line = source.slice(0, call.index).split(/\r?\n/).length
      if (!argument || !eventPattern.test(argument[2])) {
        problems.push(`${relative(projectRoot, path)}:${line}: ${argument?.[2] ?? '事件名必须是字符串字面量'}`)
      }
    }
  }
  return problems
}

describe('structured logging policy', () => {
  it('forbids direct console logging outside the logger transport', () => {
    expect(violations(/\bconsole\.(?:log|debug|info|warn|error)\s*\(/, { exclude: [loggerFile] })).toEqual([])
  })

  it('forbids removed compatibility APIs', () => {
    expect(violations(/\.\s*(?:exception|event)\s*\(/)).toEqual([])
  })

  it('forbids printf placeholders in logger calls', () => {
    expect(violations(/\blog\.(?:trace|debug|info|warn|error|fatal)\s*\([^\n]*%[sdifoO]/)).toEqual([])
  })

  it('requires literal domain.action event names', () => {
    expect(eventNameViolations()).toEqual([])
  })
})
