/**
 * 文件读写工具 —— 让 AI 在「用户授权的工作目录」内读写文件
 *
 * 能力模型见 src-tauri/src/fileio.rs：原生目录选择器签发 workspaceId，
 * Rust 只接受该不透明能力与相对路径，前端路径仅用于展示。
 */
import { invoke } from '@tauri-apps/api/core'
import type { Tool } from '../types'
import { createLogger } from '../../utils/logger'

const log = createLogger('ToolFiles')

/**
 * 取当前会话工作目录；未授权则抛出引导性错误（executor 会把它作为工具结果回给 LLM）。
 *
 * 注意：session store 在此**懒加载**而非顶层 import —— 否则会形成
 * files.ts → stores/session → stores/chat → agent(index/service, 加载即 initTools)
 * → tools/files 的循环依赖。运行时模块已加载完毕，动态 import 无开销且安全。
 */
async function requireWorkspaceId(): Promise<string> {
  const { useSessionStore } = await import('../../stores/session')
  const workspaceId = useSessionStore().currentSession?.workspaceId
  if (!workspaceId) {
    throw new Error(
      '当前会话尚未设置工作目录。请提示用户点击界面下方的「工作区」按钮选择一个目录后再重试。',
    )
  }
  return workspaceId
}

/** 列目录条目结构（与 Rust agent_list_dir 返回一致） */
interface DirEntry {
  name: string
  is_dir: boolean
  size: number
}

/** 内容搜索命中结构（与 Rust agent_search_in_files 返回一致） */
interface SearchHit {
  path: string
  line: number
  text: string
}

export const readFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        '读取工作目录内某个文本文件的内容。仅支持 UTF-8 文本。' +
        '不带行号参数时返回整个文件（上限 2MB）；' +
        '带 start_line/end_line 时只返回该行区间且输出带行号——想精确编辑前，先用行区间读取以获得行号。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对工作目录的路径，如 notes/todo.txt',
          },
          start_line: {
            type: 'integer',
            description: '起始行号（1 起，含）。省略则从第 1 行开始',
          },
          end_line: {
            type: 'integer',
            description: '结束行号（1 起，含）。省略则到文件末尾',
          },
        },
        required: ['path'],
      },
    },
  },
  handler: async (args) => {
    const workspaceId = await requireWorkspaceId()
    const relPath = String(args.path ?? '')
    const hasRange = args.start_line != null || args.end_line != null
    if (hasRange) {
      const startLine = args.start_line != null ? Number(args.start_line) : null
      const endLine = args.end_line != null ? Number(args.end_line) : null
      log.debug('read_file(lines): %s [%s,%s]', relPath, startLine, endLine)
      const text = await invoke<string>('agent_read_lines', { workspaceId, relPath, startLine, endLine })
      return text || '(空文件)'
    }
    log.debug('read_file: %s', relPath)
    const content = await invoke<string>('agent_read_file', { workspaceId, relPath })
    return content === '' ? '(空文件)' : content
  },
}

export const writeFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        '写入文本到工作目录内的文件（覆盖原有内容）。若父目录不存在会自动创建。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对工作目录的路径，如 notes/todo.txt',
          },
          content: { type: 'string', description: '要写入的完整文本内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  handler: async (args) => {
    const workspaceId = await requireWorkspaceId()
    const relPath = String(args.path ?? '')
    const content = String(args.content ?? '')
    log.debug('write_file: %s (%d 字符)', relPath, content.length)
    await invoke('agent_write_file', { workspaceId, relPath, content })
    return `已写入 ${relPath}（${content.length} 字符）`
  },
}

export const appendFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'append_file',
      description: '在工作目录内文件的末尾追加文本（不覆盖原有内容，文件不存在则创建）。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对工作目录的路径，如 notes/log.txt',
          },
          content: { type: 'string', description: '要追加的文本内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  handler: async (args) => {
    const workspaceId = await requireWorkspaceId()
    const relPath = String(args.path ?? '')
    const content = String(args.content ?? '')
    log.debug('append_file: %s (%d 字符)', relPath, content.length)
    await invoke('agent_append_file', { workspaceId, relPath, content })
    return `已追加到 ${relPath}（${content.length} 字符）`
  },
}

export const listDirTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出工作目录（或其子目录）下的文件和子目录，便于先了解结构再读写。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对工作目录的子目录路径，留空表示工作目录根',
          },
        },
      },
    },
  },
  handler: async (args) => {
    const workspaceId = await requireWorkspaceId()
    const relPath = String(args.path ?? '')
    log.debug('list_dir: %s', relPath || '(root)')
    const items = await invoke<DirEntry[]>('agent_list_dir', { workspaceId, relPath })
    if (!items.length) return '(空目录)'
    const lines = items
      .slice()
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
      .map(e => (e.is_dir ? `📁 ${e.name}/` : `📄 ${e.name} (${e.size} 字节)`))
    return lines.join('\n')
  },
}

export const deleteFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除工作目录内的某个文件（仅文件，不能删目录）。此操作不可撤销，请谨慎使用。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对工作目录的文件路径，如 notes/old.txt',
          },
        },
        required: ['path'],
      },
    },
  },
  handler: async (args) => {
    const workspaceId = await requireWorkspaceId()
    const relPath = String(args.path ?? '')
    log.debug('delete_file: %s', relPath)
    await invoke('agent_delete_file', { workspaceId, relPath })
    return `已删除 ${relPath}`
  },
}

// ─── 按行编辑（replace / insert / delete，共用 agent_edit_lines） ──────

export const replaceLinesTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'replace_lines',
      description:
        '用新内容替换文件中指定的行区间 [start_line, end_line]（1 起，含）。' +
        '编辑前建议先用 read_file 带行号读取，确认行号。content 可为多行。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径' },
          start_line: { type: 'integer', description: '起始行号（1 起，含）' },
          end_line: { type: 'integer', description: '结束行号（1 起，含）' },
          content: { type: 'string', description: '替换后的新内容（可多行；空字符串等价于删除这些行）' },
        },
        required: ['path', 'start_line', 'end_line', 'content'],
      },
    },
  },
  handler: async (args) => {
    const workspaceId = await requireWorkspaceId()
    const relPath = String(args.path ?? '')
    const startLine = Number(args.start_line)
    const endLine = Number(args.end_line)
    const content = String(args.content ?? '')
    log.debug('replace_lines: %s [%d,%d]', relPath, startLine, endLine)
    return await invoke<string>('agent_edit_lines', {
      workspaceId, relPath, operation: 'replace', startLine, endLine, content,
    })
  },
}

export const insertLinesTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'insert_lines',
      description:
        '在指定行号处插入新内容（在该行之前插入，不覆盖原有行）。' +
        'line 取 1..=总行数+1，等于总行数+1 时追加到文件末尾。content 可为多行。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径' },
          line: { type: 'integer', description: '插入位置行号（1 起，在该行之前插入）' },
          content: { type: 'string', description: '要插入的内容（可多行）' },
        },
        required: ['path', 'line', 'content'],
      },
    },
  },
  handler: async (args) => {
    const workspaceId = await requireWorkspaceId()
    const relPath = String(args.path ?? '')
    const startLine = Number(args.line)
    const content = String(args.content ?? '')
    log.debug('insert_lines: %s @%d', relPath, startLine)
    return await invoke<string>('agent_edit_lines', {
      workspaceId, relPath, operation: 'insert', startLine, endLine: null, content,
    })
  },
}

export const deleteLinesTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'delete_lines',
      description: '删除文件中指定的行区间 [start_line, end_line]（1 起，含）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径' },
          start_line: { type: 'integer', description: '起始行号（1 起，含）' },
          end_line: { type: 'integer', description: '结束行号（1 起，含）' },
        },
        required: ['path', 'start_line', 'end_line'],
      },
    },
  },
  handler: async (args) => {
    const workspaceId = await requireWorkspaceId()
    const relPath = String(args.path ?? '')
    const startLine = Number(args.start_line)
    const endLine = Number(args.end_line)
    log.debug('delete_lines: %s [%d,%d]', relPath, startLine, endLine)
    return await invoke<string>('agent_edit_lines', {
      workspaceId, relPath, operation: 'delete', startLine, endLine, content: null,
    })
  },
}

// ─── 查找 / 搜索 ───────────────────────────────────────

export const findFilesTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'find_files',
      description:
        '在工作目录内按文件名递归查找文件。pattern 支持通配符 * 和 ?（大小写不敏感），如 *.txt、note*.md。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '文件名通配符，如 *.txt' },
          path: { type: 'string', description: '限定在某子目录下查找（相对工作目录），留空表示整个工作目录' },
        },
        required: ['pattern'],
      },
    },
  },
  handler: async (args) => {
    const workspaceId = await requireWorkspaceId()
    const pattern = String(args.pattern ?? '')
    const relPath = args.path != null ? String(args.path) : null
    log.debug('find_files: %s (in %s)', pattern, relPath || '(root)')
    const list = await invoke<string[]>('agent_find_files', { workspaceId, pattern, relPath })
    if (!list.length) return '(无匹配)'
    let out = list.join('\n')
    if (list.length >= 200) out += '\n…（结果较多，已截断，请缩小范围）'
    return out
  },
}

export const searchInFilesTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_in_files',
      description:
        '在工作目录内按内容递归搜索（大小写不敏感子串），返回命中的「文件:行号: 该行内容」。仅搜索 UTF-8 文本文件。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的关键词' },
          path: { type: 'string', description: '限定在某子目录下搜索（相对工作目录），留空表示整个工作目录' },
        },
        required: ['query'],
      },
    },
  },
  handler: async (args) => {
    const workspaceId = await requireWorkspaceId()
    const query = String(args.query ?? '')
    const relPath = args.path != null ? String(args.path) : null
    log.debug('search_in_files: %s (in %s)', query, relPath || '(root)')
    const hits = await invoke<SearchHit[]>('agent_search_in_files', { workspaceId, query, relPath })
    if (!hits.length) return '(无匹配)'
    let out = hits.map(h => `${h.path}:${h.line}: ${h.text}`).join('\n')
    if (hits.length >= 100) out += '\n…（命中较多，已截断，请缩小范围或换更具体的关键词）'
    return out
  },
}
