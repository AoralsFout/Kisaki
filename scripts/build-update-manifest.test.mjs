import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archFromName,
  assertExpectedPlatforms,
  buildManifest,
  platformFromDir,
} from './build-update-manifest.mjs'

const roots = []

function artifact(name, payloadName) {
  const root = mkdtempSync(join(tmpdir(), 'kisaki-manifest-'))
  roots.push(root)
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, payloadName), 'payload')
  writeFileSync(join(dir, `${payloadName}.sig`), `signature-${name}`)
  return dir
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true })
})

describe('build update manifest', () => {
  it('uses explicit artifact architecture for macOS payloads without arch in filename', () => {
    const dir = artifact('kisaki-macos-aarch64', 'Kisaki.app.tar.gz')
    const manifest = buildManifest('v1.0.0', 'owner/repo', [dir], '2026-01-01T00:00:00.000Z')

    expect(manifest.platforms['darwin-aarch64']).toEqual({
      signature: 'signature-kisaki-macos-aarch64',
      url: 'https://github.com/owner/repo/releases/download/v1.0.0/Kisaki.app.tar.gz',
    })
  })

  it('builds every expected first-release platform', () => {
    const dirs = [
      artifact('kisaki-windows-x86_64', 'Kisaki_1.0.0_x64_en-US.msi'),
      artifact('kisaki-macos-aarch64', 'Kisaki.app.tar.gz'),
      artifact('kisaki-linux-x86_64', 'Kisaki_1.0.0_amd64.AppImage'),
    ]
    const manifest = buildManifest('v1.0.0', 'owner/repo', dirs)

    expect(() => assertExpectedPlatforms(
      manifest,
      'windows-x86_64,darwin-aarch64,linux-x86_64',
    )).not.toThrow()
  })

  it('does not choose deb or rpm packages as Linux updater payloads', () => {
    const root = mkdtempSync(join(tmpdir(), 'kisaki-manifest-'))
    roots.push(root)
    const dir = join(root, 'kisaki-linux-x86_64')
    mkdirSync(dir, { recursive: true })
    for (const name of ['Kisaki_1.0.0_amd64.deb', 'Kisaki-1.0.0.x86_64.rpm', 'Kisaki_1.0.0_amd64.AppImage']) {
      writeFileSync(join(dir, name), 'payload')
      writeFileSync(join(dir, `${name}.sig`), `sig-${name}`)
    }
    const manifest = buildManifest('v1.0.0', 'owner/repo', [dir])
    expect(manifest.platforms['linux-x86_64'].url).toMatch(/\.AppImage$/)
  })

  it('fails when an expected platform is absent', () => {
    const dir = artifact('kisaki-windows-x86_64', 'Kisaki_1.0.0_x64_en-US.msi')
    const manifest = buildManifest('v1.0.0', 'owner/repo', [dir])

    expect(() => assertExpectedPlatforms(manifest, 'windows-x86_64,darwin-aarch64'))
      .toThrow('darwin-aarch64')
  })

  it('keeps filename parsing for legacy artifact directories', () => {
    expect(archFromName('Kisaki_1.0.0_amd64.AppImage')).toBe('x86_64')
    expect(platformFromDir('kisaki-linux')).toEqual({ os: 'linux', arch: null })
  })
})
