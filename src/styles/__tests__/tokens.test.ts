/**
 * 设计令牌与共享样式守卫（阶段 4）
 *
 * 保证 tokens.css 覆盖核心变量、ui.css 提供共享类，
 * 防止后续改动把样式重新散落回各组件。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

function vueFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return vueFiles(path)
    return entry.name.endsWith('.vue') ? [path] : []
  })
}

describe('design tokens', () => {
  const css = read('../../styles/tokens.css')

  it('keeps the brand blue and dark indigo background', () => {
    expect(css).toContain('--c-brand: #4a7aff')
    expect(css).toContain('--c-bg: #16162a')
  })

  it('defines the semantic status colors', () => {
    expect(css).toContain('--c-ok:')
    expect(css).toContain('--c-warn:')
    expect(css).toContain('--c-error:')
  })

  it('defines the radius scale (control 8 / card 12 / overlay 16)', () => {
    expect(css).toContain('--radius-control: 8px')
    expect(css).toContain('--radius-card: 12px')
    expect(css).toContain('--radius-overlay: 16px')
    expect(css).toContain('--radius-pill:')
  })

  it('defines the 4px spacing scale and font sizes', () => {
    expect(css).toContain('--space-1: 4px')
    expect(css).toContain('--fs-body: 14px')
    expect(css).toContain('--fs-aux: 12px')
    expect(css).toContain('--fs-title: 20px')
    expect(css).toContain('--font-mono:')
    expect(css).toContain('--font-code:')
    expect(css).toContain('--fs-code:')
    expect(css).toContain('--lh-code:')
  })
})

describe('shared ui stylesheet', () => {
  const css = read('../../styles/ui.css')

  it('provides the three button variants', () => {
    expect(css).toContain('.btn-primary')
    expect(css).toContain('.btn-secondary')
    expect(css).toContain('.btn-danger')
  })

  it('provides shared form, toggle and status classes', () => {
    expect(css).toContain('.form-input')
    expect(css).toContain('.form-label')
    expect(css).toContain('.form-hint')
    expect(css).toContain('.toggle-switch')
    expect(css).toContain('.status-ok')
    expect(css).toContain('.status-error')
  })

  it('provides shared code block typography', () => {
    expect(css).toContain('.code-block')
    expect(css).toContain('font-family: var(--font-code)')
    expect(css).toContain('line-height: var(--lh-code)')
  })

  it('applies shared typography to every pre element', () => {
    const componentRoot = resolve(process.cwd(), 'src', 'components')
    const preTags = vueFiles(componentRoot).flatMap(path =>
      readFileSync(path, 'utf-8').match(/<pre\b[^>]*>/g) ?? [],
    )

    expect(preTags.length).toBeGreaterThan(0)
    expect(preTags.filter(tag => !/class=["'][^"']*\bcode-block\b/.test(tag))).toEqual([])
  })

  it('reduces motion for both the system preference and the in-app override', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain(":root[data-reduced-motion='true']")
    expect(css).toContain('scroll-behavior: auto !important')
  })
})
