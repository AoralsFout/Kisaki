import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('canvas toolbar opacity control', () => {
  it('exposes a keyboard and wheel control with a live percentage label', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8')
    const button = source.match(/<button class="tool-btn" type="button"\n\s*:aria-label="t\('app\.aria\.adjustCharacterOpacity',[\s\S]*?<\/button>/)?.[0] || ''

    expect(button).toContain('aria-keyshortcuts="ArrowUp ArrowDown"')
    expect(button).toContain('@wheel.prevent.stop="onCharacterOpacityWheel"')
    expect(button).toContain('@keydown="onCharacterOpacityKeydown"')
    expect(button).toContain('characterOpacityPercent')
    expect(button).toContain('fa-sun')
  })
})
