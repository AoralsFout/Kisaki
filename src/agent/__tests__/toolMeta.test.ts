/**
 * 工具展示元信息单测 —— toolIcon 映射
 */
import { describe, it, expect } from 'vitest'
import { toolIcon } from '../toolMeta'

describe('toolIcon', () => {
  it('已知工具返回对应图标', () => {
    expect(toolIcon('read_file')).toBe('fa-file-lines')
    expect(toolIcon('write_file')).toBe('fa-file-pen')
    expect(toolIcon('list_dir')).toBe('fa-folder-open')
    expect(toolIcon('delete_file')).toBe('fa-trash')
    expect(toolIcon('set_character_emotion')).toBe('fa-face-smile')
    expect(toolIcon('switch_character')).toBe('fa-rotate')
    expect(toolIcon('get_time')).toBe('fa-clock')
  })

  it('未知工具返回兜底图标 fa-gear', () => {
    expect(toolIcon('unknown_tool')).toBe('fa-gear')
    expect(toolIcon('')).toBe('fa-gear')
    expect(toolIcon('say')).toBe('fa-gear') // say 不在映射内（不进列表）
  })

  it('覆盖全部 15 个已注册工具，均非兜底', () => {
    const names = [
      'get_time', 'get_weather', 'calculator',
      'set_character_emotion', 'set_character_stance', 'set_character_costume',
      'set_character_look', 'set_screen_pose', 'get_character_state', 'switch_character',
      'read_file', 'write_file', 'append_file', 'list_dir', 'delete_file',
    ]
    for (const n of names) {
      expect(toolIcon(n), `${n} 应有专属图标`).not.toBe('fa-gear')
    }
  })
})
