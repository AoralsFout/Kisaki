#!/usr/bin/env node
/**
 * 生成自动更新的 latest.json（update manifest）
 *
 * 在 CI 的 release 阶段运行：扫描 download-artifact 拉下来的各平台 bundle 目录，
 * 找到 `createUpdaterArtifacts` 生成的 `*.sig` 签名文件，据此反推各平台更新载荷，
 * 组装出带 GitHub Release 下载地址与签名的 manifest，写到 ./latest.json。
 *
 * 用法：
 *   node scripts/build-update-manifest.mjs <tag> <repo> [artifactDir...]
 *   例：node scripts/build-update-manifest.mjs v0.2.2 AoralsFout/Kisaki
 *   （不传 artifactDir 时默认扫描当前目录下的 kisaki-* 目录）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 顶层 artifact 目录名 → 平台 OS 段 */
const OS_BY_DIR = {
  'kisaki-windows': 'windows',
  'kisaki-macos': 'darwin',
  'kisaki-linux': 'linux',
}

function listDirs() {
  try {
    return readdirSync(process.cwd()).filter((d) => /^kisaki-/i.test(d))
  } catch {
    return []
  }
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile()) out.push(p)
  }
  return out
}

export function osFromDir(dir) {
  return OS_BY_DIR[basename(dir).toLowerCase()]
}

export function archFromName(name) {
  if (/(aarch64|arm64)/i.test(name)) return 'aarch64'
  if (/(x86_64|x64|amd64)/i.test(name)) return 'x86_64'
  return null
}

/**
 * CI artifact 目录携带权威平台信息：kisaki-<os>-<arch>。
 * 旧目录名仍兼容，但架构只能回退到载荷文件名识别。
 */
export function platformFromDir(dir) {
  const name = basename(dir).toLowerCase()
  const matched = /^kisaki-(windows|macos|linux)-(x86_64|aarch64|i686|armv7)$/.exec(name)
  if (matched) {
    const os = matched[1] === 'macos' ? 'darwin' : matched[1]
    return { os, arch: matched[2] }
  }
  return { os: osFromDir(dir), arch: null }
}

/** 只选择 Tauri updater 能直接安装的载荷，避免误把 deb/rpm 放进 Linux 清单。 */
function priority(name, os) {
  if (os === 'windows' && name.endsWith('.msi')) return 30
  if (os === 'windows' && name.endsWith('.exe')) return 20
  if (os === 'darwin' && name.endsWith('.app.tar.gz')) return 30
  if (os === 'linux' && name.endsWith('.AppImage')) return 30
  if (os === 'linux' && name.endsWith('.AppImage.tar.gz')) return 20
  return -1
}

/** 从已下载的 CI artifacts 构建静态更新清单。 */
export function buildManifest(tag, repo, dirs, pubDate = new Date().toISOString()) {
  if (!tag || !repo) throw new Error('tag 与 repo 均为必填')
  const version = tag.replace(/^v/, '')
  const chosen = {} // platformKey -> { signature, url, prio }

  for (const dir of dirs) {
    const { os, arch: artifactArch } = platformFromDir(dir)
    if (!os) {
      console.warn(`跳过未知目录: ${dir}`)
      continue
    }
    for (const sigFile of walk(dir)) {
      if (!sigFile.endsWith('.sig')) continue
      const payload = sigFile.slice(0, -'.sig'.length)
      const name = basename(payload)
      const prio = priority(name, os)
      if (prio < 0) continue
      if (!existsSync(payload)) {
        throw new Error(`签名对应的更新载荷不存在: ${payload}`)
      }
      const filenameArch = archFromName(name)
      if (artifactArch && filenameArch && artifactArch !== filenameArch) {
        throw new Error(`artifact 架构与文件名不一致: ${dir} / ${name}`)
      }
      const arch = artifactArch ?? filenameArch
      if (!arch) {
        console.warn(`跳过无法识别架构的载荷: ${name}`)
        continue
      }

      let signature
      try {
        signature = readFileSync(sigFile, 'utf8').trim()
      } catch (e) {
        console.error(`读取签名失败: ${sigFile}: ${e.message}`)
        throw e
      }
      if (!signature) {
        console.warn(`签名为空，跳过: ${sigFile}`)
        continue
      }

      const key = `${os}-${arch}`
      const url = `https://github.com/${repo}/releases/download/${tag}/${name}`
      if (!chosen[key] || prio > chosen[key].prio) {
        chosen[key] = { signature, url, prio }
      }
    }
  }

  if (Object.keys(chosen).length === 0) {
    throw new Error(`未找到任何可用的 *.sig 与载荷；扫描目录: ${dirs.join(', ')}`)
  }

  const platforms = {}
  for (const [key, v] of Object.entries(chosen)) {
    platforms[key] = { signature: v.signature, url: v.url }
  }

  return {
    version,
    notes: `Kisaki ${version}`,
    pub_date: pubDate,
    platforms,
  }
}

/** 缺少任何首发目标都阻止发布，避免生成半残 latest.json。 */
export function assertExpectedPlatforms(manifest, expectedCsv) {
  const expected = String(expectedCsv || '').split(',').map(v => v.trim()).filter(Boolean)
  const missing = expected.filter(key => !manifest.platforms[key])
  if (missing.length) throw new Error(`更新清单缺少预期平台: ${missing.join(', ')}`)
}

export function main(argv = process.argv.slice(2)) {
  const [tag, repo, ...explicitDirs] = argv
  if (!tag || !repo) {
    throw new Error('用法: node scripts/build-update-manifest.mjs <tag> <repo> [artifactDir...]')
  }
  const dirs = explicitDirs.length ? explicitDirs : listDirs()
  const manifest = buildManifest(tag, repo, dirs)
  assertExpectedPlatforms(manifest, process.env.KISAKI_EXPECTED_PLATFORMS)
  writeFileSync('latest.json', JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log('✔ 已生成 latest.json，平台:')
  console.log(JSON.stringify(manifest.platforms, null, 2))
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
