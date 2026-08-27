// 把 characters/ 下所有角色目录打成一个官方角色包 zip，供 release 分发、用户在 app 内一键导入。
// 用法：npm run pack:characters
// 产物：dist-packs/kisaki-characters.zip（zip 内路径形如 <id>/character.json、<id>/images/x.png，
//       与后端 import_character_pack 命令的约定一致）。
import AdmZip from 'adm-zip'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const charsDir = join(root, 'characters')
const outDir = join(root, 'dist-packs')
const outFile = join(outDir, 'characters.zip')
const allowlistFile = join(charsDir, 'release-allowlist.json')

if (!existsSync(charsDir)) {
  console.error(`找不到角色目录: ${charsDir}`)
  process.exit(1)
}

if (!existsSync(allowlistFile)) {
  console.error(`缺少正式分发角色清单: ${allowlistFile}`)
  process.exit(1)
}

const allowlist = JSON.parse(readFileSync(allowlistFile, 'utf8'))
const entries = Array.isArray(allowlist.characters) ? allowlist.characters : []
const invalid = entries.filter((entry) => (
  !entry?.id
  || !existsSync(join(charsDir, entry.id, 'character.json'))
))
if (invalid.length) {
  console.error(`正式分发角色清单存在无效条目: ${invalid.map(v => v?.id || '?').join(', ')}`)
  process.exit(1)
}

const ids = entries.map(entry => entry.id)

if (ids.length === 0) {
  console.error('没有任何正式分发角色。请先补充 characters/release-allowlist.json。')
  process.exit(1)
}

const zip = new AdmZip()
for (const id of ids) {
  // addLocalFolder(localPath, zipPath)：以 <id> 作为 zip 内前缀
  zip.addLocalFolder(join(charsDir, id), id)
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
zip.writeZip(outFile)
console.log(`已打包 ${ids.length} 个角色 → ${outFile}`)
console.log(`角色: ${ids.join(', ')}`)
