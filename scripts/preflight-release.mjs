#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'

const requestedTag = process.argv[2] || process.env.GITHUB_REF_NAME || ''
const errors = []
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const tauri = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8')
const cargoVersion = /^version = "([^"]+)"/m.exec(cargo)?.[1]

if (pkg.version !== tauri.version || pkg.version !== cargoVersion) {
  errors.push(`版本不一致: package=${pkg.version}, tauri=${tauri.version}, cargo=${cargoVersion}`)
}
if (requestedTag && requestedTag !== `v${pkg.version}`) {
  errors.push(`tag ${requestedTag} 与应用版本 v${pkg.version} 不一致`)
}
if (tauri.app?.security?.assetProtocol?.scope?.includes?.('**')) {
  errors.push('assetProtocol 仍允许全盘 ** scope')
}
if (!tauri.plugins?.updater?.pubkey || !tauri.plugins?.updater?.endpoints?.length) {
  errors.push('updater 公钥或端点未配置')
}
if (!/default\s*=\s*\[\s*\]/.test(cargo)) {
  errors.push('Cargo 默认 feature 必须为空，禁止正式版默认开启实验命令')
}

for (const file of [
  'PRIVACY.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'CHANGELOG.md',
  'docs/release-readiness.md',
  'docs/rc-test-matrix.md',
  'docs/release-runbook.md',
]) {
  if (!existsSync(file)) errors.push(`缺少发布文档: ${file}`)
}

const allowlist = JSON.parse(readFileSync('characters/release-allowlist.json', 'utf8'))
const chars = Array.isArray(allowlist.characters) ? allowlist.characters : []
if (!chars.length) errors.push('正式分发角色白名单为空')
for (const entry of chars) {
  if (!entry?.id) {
    errors.push(`角色条目缺少 id: ${JSON.stringify(entry)}`)
  }
  if (entry?.id && !existsSync(`characters/${entry.id}/character.json`)) {
    errors.push(`角色目录不存在: ${entry.id}`)
  }
}

if (errors.length) {
  console.error('正式发布预检失败:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`正式发布预检通过: v${pkg.version}; distributed characters: ${chars.map(v => v.id).join(', ')}`)
