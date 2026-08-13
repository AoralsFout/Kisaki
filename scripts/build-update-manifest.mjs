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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const [, , tag, repo, ...explicitDirs] = process.argv

if (!tag || !repo) {
  console.error('用法: node scripts/build-update-manifest.mjs <tag> <repo> [artifactDir...]')
  process.exit(1)
}

const version = tag.replace(/^v/, '')

/** 顶层 artifact 目录名 → 平台 OS 段 */
const OS_BY_DIR = {
  'kisaki-windows': 'windows',
  'kisaki-macos': 'darwin',
  'kisaki-linux': 'linux',
}

function listDirs() {
  if (explicitDirs.length) return explicitDirs
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

function osFromDir(dir) {
  return OS_BY_DIR[basename(dir).toLowerCase()]
}

function archFromName(name) {
  if (/(aarch64|arm64)/i.test(name)) return 'aarch64'
  if (/(x86_64|x64|amd64)/i.test(name)) return 'x86_64'
  return null
}

/** Windows 同时产出 .msi 与 -setup.exe 时，优先 .msi（静默/被动安装更稳） */
function priority(name) {
  if (name.endsWith('.msi')) return 2
  if (name.endsWith('.exe')) return 1
  return 0
}

const chosen = {} // platformKey -> { signature, url, prio }
const dirs = listDirs()

for (const dir of dirs) {
  const os = osFromDir(dir)
  if (!os) {
    console.warn(`跳过未知目录: ${dir}`)
    continue
  }
  for (const sigFile of walk(dir)) {
    if (!sigFile.endsWith('.sig')) continue
    const payload = sigFile.slice(0, -'.sig'.length)
    const name = basename(payload)
    const arch = archFromName(name)
    if (!arch) {
      console.warn(`跳过无法识别架构的载荷: ${name}`)
      continue
    }

    let signature
    try {
      signature = readFileSync(sigFile, 'utf8').trim()
    } catch (e) {
      console.error(`读取签名失败: ${sigFile}: ${e.message}`)
      process.exit(1)
    }
    if (!signature) {
      console.warn(`签名为空，跳过: ${sigFile}`)
      continue
    }

    const key = `${os}-${arch}`
    const url = `https://github.com/${repo}/releases/download/${tag}/${name}`
    const prio = priority(name)
    if (!chosen[key] || prio > chosen[key].prio) {
      chosen[key] = { signature, url, prio }
    }
  }
}

if (Object.keys(chosen).length === 0) {
  console.error('未找到任何 *.sig 文件，无法生成 manifest。')
  console.error('请确认 createUpdaterArtifacts=true、已注入签名私钥、且构建产物已上传。')
  console.error('扫描到的目录:', dirs)
  process.exit(1)
}

const platforms = {}
for (const [key, v] of Object.entries(chosen)) {
  platforms[key] = { signature: v.signature, url: v.url }
}

const manifest = {
  version,
  notes: `Kisaki ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
}

writeFileSync('latest.json', JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log('✔ 已生成 latest.json，平台:')
console.log(JSON.stringify(platforms, null, 2))
