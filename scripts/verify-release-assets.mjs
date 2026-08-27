#!/usr/bin/env node

const tag = process.argv[2]
const repository = process.argv[3] || process.env.GITHUB_REPOSITORY || 'AoralsFout/Kisaki'

if (!tag) {
  console.error('用法: npm run release:verify -- <tag> [owner/repo]')
  process.exit(2)
}

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'kisaki-release-verifier',
}
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

async function get(url, asJson = true) {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`)
  return asJson ? response.json() : response.text()
}

function requireAsset(names, pattern, description, errors) {
  if (!names.some(name => pattern.test(name))) errors.push(`缺少${description}`)
}

async function main() {
  const apiBase = `https://api.github.com/repos/${repository}`
  const release = await get(`${apiBase}/releases/tags/${encodeURIComponent(tag)}`)
  const assets = new Map(release.assets.map(asset => [asset.name, asset]))
  const names = [...assets.keys()]
  const errors = []

  if (release.draft) errors.push('Release 仍为 draft')
  requireAsset(names, /\.(msi|exe)$/i, ' Windows 安装包', errors)
  requireAsset(names, /\.dmg$/i, ' macOS 安装包', errors)
  requireAsset(names, /\.AppImage$/i, ' Linux AppImage', errors)
  for (const required of ['latest.json', 'characters.zip', 'SHA256SUMS.txt']) {
    if (!assets.has(required)) errors.push(`缺少 ${required}`)
  }

  if (assets.has('latest.json')) {
    const manifest = await get(assets.get('latest.json').browser_download_url)
    const expected = ['windows-x86_64', 'darwin-aarch64', 'linux-x86_64']
    for (const platform of expected) {
      const entry = manifest.platforms?.[platform]
      if (!entry?.signature || !entry?.url) {
        errors.push(`latest.json 缺少完整平台条目: ${platform}`)
        continue
      }
      const payloadName = decodeURIComponent(new URL(entry.url).pathname.split('/').pop())
      if (!assets.has(payloadName)) errors.push(`latest.json 引用了未上传的文件: ${payloadName}`)
    }
    if (manifest.version !== tag.replace(/^v/, '')) {
      errors.push(`latest.json 版本 ${manifest.version} 与 tag ${tag} 不一致`)
    }
  }

  if (assets.has('SHA256SUMS.txt')) {
    const checksums = await get(assets.get('SHA256SUMS.txt').browser_download_url, false)
    for (const required of ['latest.json', 'characters.zip']) {
      if (!checksums.includes(required)) errors.push(`SHA256SUMS.txt 未包含 ${required}`)
    }
  }

  if (errors.length) {
    console.error(`Release ${tag} 验证失败:`)
    for (const error of errors) console.error(`- ${error}`)
    process.exit(1)
  }

  console.log(`Release ${tag} 产物验证通过，共 ${names.length} 个文件；三平台 updater 清单完整。`)
}

main().catch(error => {
  console.error(`Release ${tag} 验证异常: ${error.message}`)
  process.exit(1)
})
