/**
 * 文件读写工具 —— 让 AI 在「用户授权的工作目录」内读写文件
 *
 * 沙箱模型见 src-tauri/src/fileio.rs：工作目录按会话存储（session.workspaceRoot），
 * 由用户在主窗口的「工作区」按钮手动授权。本模块每个工具：
 *   1. 取当前会话的 workspaceRoot；未授权则抛错，提示 AI 引导用户去设置。
 *   2. 把 root 与相对路径传给对应的 Rust 命令（LLM 只能提供相对路径）。
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
async function requireRoot(): Promise<string> {
  const { useSessionStore } = await import('../../stores/session')
  const root = useSessionStore().currentSession?.workspaceRoot
  if (!root) {
    throw new Error(
      '当前会话尚未设置工作目录。请提示用户点击界面下方的「工作区」按钮选择一个目录后再重试。',
    )
  }
  return root
}

/** 列目录条目结构（与 Rust agent_list_dir 返回一致） */
interface DirEntry {
  name: string
  is_dir: boolean
  size: number
}

export const readFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        '读取工作目录内某个文本文件的内容。仅支持 UTF-8 文本，单文件上限 2MB。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对工作目录的路径，如 notes/todo.txt',
          },
        },
        required: ['path'],
      },
    },
  },
  handler: async (args) => {
    const root = await requireRoot()
    const relPath = String(args.path ?? '')
    log.debug('read_file: %s', relPath)
    const content = await invoke<string>('agent_read_file', { root, relPath })
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
    const root = await requireRoot()
    const relPath = String(args.path ?? '')
    const content = String(args.content ?? '')
    log.debug('write_file: %s (%d 字符)', relPath, content.length)
    await invoke('agent_write_file', { root, relPath, content })
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
    const root = await requireRoot()
    const relPath = String(args.path ?? '')
    const content = String(args.content ?? '')
    log.debug('append_file: %s (%d 字符)', relPath, content.length)
    await invoke('agent_append_file', { root, relPath, content })
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
    const root = await requireRoot()
    const relPath = String(args.path ?? '')
    log.debug('list_dir: %s', relPath || '(root)')
    const items = await invoke<DirEntry[]>('agent_list_dir', { root, relPath })
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
    const root = await requireRoot()
    const relPath = String(args.path ?? '')
    log.debug('delete_file: %s', relPath)
    await invoke('agent_delete_file', { root, relPath })
    return `已删除 ${relPath}`
  },
}
