import { readFile, writeFile } from 'node:fs/promises'

const schemaPath = new URL('../shared/log-schema-v2.json', import.meta.url)
const outputPath = new URL('../src/utils/logSchema.generated.d.ts', import.meta.url)
const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
const levels = schema.fields?.level?.values

if (!Array.isArray(levels) || levels.length === 0 || levels.some(level => typeof level !== 'string')) {
  throw new Error('共享日志声明必须提供非空的字符串级别列表')
}
if (new Set(levels).size !== levels.length) {
  throw new Error('共享日志声明的级别列表不能重复')
}

const output = [
  '// 根据共享日志声明自动生成，请勿手动编辑。',
  `export type LogLevel = ${levels.map(level => JSON.stringify(level)).join(' | ')}`,
  '',
].join('\n')

if (process.argv.includes('--check')) {
  let current
  try {
    current = await readFile(outputPath, 'utf8')
  } catch {
    current = ''
  }
  if (current.replace(/\r\n?/g, '\n') !== output) {
    console.error('日志级别类型已过期，请运行 node scripts/generate-log-schema-types.mjs')
    process.exitCode = 1
  }
} else {
  await writeFile(outputPath, output, 'utf8')
}
