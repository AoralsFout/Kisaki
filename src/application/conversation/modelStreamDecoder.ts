export interface ModelStreamSnapshot {
  thinking: string
  visibleText: string
  sawThink: boolean
  thinkComplete: boolean
}

function clone(snapshot: ModelStreamSnapshot): ModelStreamSnapshot {
  return { ...snapshot }
}

/**
 * 把服务端内容增量解码为思考过程与用户可见文本。
 * 分片边界由它负责处理，展示层因此永远不必解析协议标签。
 */
export class ModelStreamDecoder {
  private content = ''
  private value: ModelStreamSnapshot = {
    thinking: '',
    visibleText: '',
    sawThink: false,
    thinkComplete: false,
  }

  snapshot(): ModelStreamSnapshot {
    return clone(this.value)
  }

  pushContent(delta: string): ModelStreamSnapshot {
    if (this.value.thinkComplete) {
      this.value.visibleText += delta
      return this.snapshot()
    }

    this.content += delta
    const match = this.content.match(/^([\s\S]*?)<\/think>\s*([\s\S]*)$/)
    if (match) {
      this.value = {
        thinking: match[1].replace(/^<think>\s*/, ''),
        visibleText: match[2],
        sawThink: true,
        thinkComplete: true,
      }
      return this.snapshot()
    }

    if (this.content.includes('<think>') && !this.content.includes('</think>')) {
      this.value.sawThink = true
      this.value.thinking = this.content.replace(/^[\s\S]*?<think>\s*/, '')
      this.value.visibleText = ''
      return this.snapshot()
    }

    const possibleOpeningTag = this.content.trimStart()
    if (possibleOpeningTag && '<think>'.startsWith(possibleOpeningTag)) return this.snapshot()
    this.value.visibleText = this.content
    return this.snapshot()
  }

  pushThinking(delta: string): ModelStreamSnapshot {
    this.value.thinking += delta
    return this.snapshot()
  }
}

/** 解析完整的 say 工具载荷；输入格式非法时按空对象处理。 */
export function parseSayArgs(argStr: string): { voice?: string; display?: string } {
  try {
    const value = JSON.parse(argStr || '{}')
    if (value && typeof value === 'object') {
      return {
        voice: typeof value.voice === 'string' ? value.voice.trim() : undefined,
        display: typeof value.display === 'string' ? value.display.trim() : undefined,
      }
    }
  } catch { /* 服务端输出格式非法 */ }
  return {}
}

/** 解码流式 say 载荷中已经到达的字段：载荷可能尚未接收完整。 */
export function extractPartialSayArgs(argStr: string): { voice?: string; display?: string } {
  return {
    voice: extractPartialStringField(argStr, 'voice'),
    display: extractPartialStringField(argStr, 'display'),
  }
}

function extractPartialStringField(json: string, field: string): string | undefined {
  const keyPattern = new RegExp(`(?:^|[,{])\\s*"${field}"\\s*:\\s*"`, 'g')
  const match = keyPattern.exec(json)
  if (!match) return undefined

  let raw = ''
  let escaped = false
  for (let index = keyPattern.lastIndex; index < json.length; index++) {
    const character = json[index]
    if (escaped) {
      raw += `\\${character}`
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') break
    raw += character
  }
  if (escaped) raw += '\\'

  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
}
