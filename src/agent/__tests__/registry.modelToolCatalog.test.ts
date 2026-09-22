import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initTools } from '../index'
import { getDefinitions } from '../registry'
import { assembleRoundToolList } from '../../application/conversation/roundToolList'

/**
 * 这是发给模型的协议清单契约，而不是注册表的实现细节：
 * 序列化后的名称、参数和顺序发生变化时，必须显式更新快照并评估模型兼容性。
 */
describe('模型可见工具清单契约', () => {
  beforeAll(() => initTools())

  beforeEach(() => {
    localStorage.clear()
  })

  it('固定安全默认配置下的名称、参数与顺序', () => {
    const context = {
      data: {
        render: 'illustration',
        emotions: ['neutral', 'happy'],
        poses: ['normal'],
        costumes: ['default'],
      },
      capabilities: null,
      hasWorkspace: true,
    } as const
    const definitions = assembleRoundToolList(
      { definitions: getDefinitions },
      context,
      true,
    )

    const serialized = definitions.map(definition => ({
      name: definition.function.name,
      parameters: definition.function.parameters,
    }))

    expect(serialized).toMatchInlineSnapshot(`
      [
        {
          "name": "get_time",
          "parameters": {
            "properties": {
              "timezone": {
                "description": "时区，如 Asia/Shanghai、America/New_York，默认为本地时区",
                "type": "string",
              },
            },
            "type": "object",
          },
        },
        {
          "name": "get_weather",
          "parameters": {
            "properties": {
              "city": {
                "description": "城市名，如 北京、上海、Tokyo、London",
                "type": "string",
              },
              "days": {
                "description": "预报天数（1-3），默认为1（仅当天）",
                "type": "number",
              },
            },
            "required": [
              "city",
            ],
            "type": "object",
          },
        },
        {
          "name": "calculator",
          "parameters": {
            "properties": {
              "expression": {
                "description": "数学表达式，如 "3.5 * 4 + 2" 或 "(15 + 3) / 2"",
                "type": "string",
              },
            },
            "required": [
              "expression",
            ],
            "type": "object",
          },
        },
        {
          "name": "web_search",
          "parameters": {
            "properties": {
              "count": {
                "description": "返回结果条数（1-5），默认 3",
                "type": "number",
              },
              "query": {
                "description": "搜索关键词，尽量具体明确",
                "type": "string",
              },
              "time_range": {
                "description": "时效范围，查最新信息用 day/week，默认 any",
                "enum": [
                  "day",
                  "week",
                  "month",
                  "year",
                  "any",
                ],
                "type": "string",
              },
            },
            "required": [
              "query",
            ],
            "type": "object",
          },
        },
        {
          "name": "set_character_emotion",
          "parameters": {
            "properties": {
              "emotion": {
                "description": "可选: neutral、happy",
                "enum": [
                  "neutral",
                  "happy",
                ],
                "type": "string",
              },
            },
            "required": [
              "emotion",
            ],
            "type": "object",
          },
        },
        {
          "name": "set_character_stance",
          "parameters": {
            "properties": {
              "stance": {
                "description": "可选: normal",
                "enum": [
                  "normal",
                ],
                "type": "string",
              },
            },
            "required": [
              "stance",
            ],
            "type": "object",
          },
        },
        {
          "name": "set_character_costume",
          "parameters": {
            "properties": {
              "costume": {
                "description": "可选: default",
                "enum": [
                  "default",
                ],
                "type": "string",
              },
            },
            "required": [
              "costume",
            ],
            "type": "object",
          },
        },
        {
          "name": "set_character_look",
          "parameters": {
            "properties": {
              "costume": {
                "description": "可选: default",
                "enum": [
                  "default",
                ],
                "type": "string",
              },
              "emotion": {
                "description": "可选: neutral、happy",
                "enum": [
                  "neutral",
                  "happy",
                ],
                "type": "string",
              },
              "stance": {
                "description": "可选: normal",
                "enum": [
                  "normal",
                ],
                "type": "string",
              },
            },
            "type": "object",
          },
        },
        {
          "name": "set_screen_pose",
          "parameters": {
            "properties": {
              "pose": {
                "description": "位置预设: full-center(全身 - 中)、full-left(全身 - 左)、full-right(全身 - 右)、half-center(半身 - 中)、half-left(半身 - 左)、half-right(半身 - 右)、headshot-center(头像 - 中)、headshot-left(头像 - 左)、headshot-right(头像 - 右)",
                "enum": [
                  "full-center",
                  "full-left",
                  "full-right",
                  "half-center",
                  "half-left",
                  "half-right",
                  "headshot-center",
                  "headshot-left",
                  "headshot-right",
                ],
                "type": "string",
              },
            },
            "required": [
              "pose",
            ],
            "type": "object",
          },
        },
        {
          "name": "get_character_state",
          "parameters": {
            "properties": {},
            "type": "object",
          },
        },
        {
          "name": "read_file",
          "parameters": {
            "properties": {
              "end_line": {
                "description": "结束行号（1 起，含）。省略则到文件末尾",
                "type": "integer",
              },
              "path": {
                "description": "相对工作目录的路径，如 notes/todo.txt",
                "type": "string",
              },
              "start_line": {
                "description": "起始行号（1 起，含）。省略则从第 1 行开始",
                "type": "integer",
              },
            },
            "required": [
              "path",
            ],
            "type": "object",
          },
        },
        {
          "name": "read_image",
          "parameters": {
            "properties": {
              "path": {
                "description": "相对工作目录的图片路径，如 screenshots/error.png",
                "type": "string",
              },
            },
            "required": [
              "path",
            ],
            "type": "object",
          },
        },
        {
          "name": "write_file",
          "parameters": {
            "properties": {
              "content": {
                "description": "要写入的完整文本内容",
                "type": "string",
              },
              "path": {
                "description": "相对工作目录的路径，如 notes/todo.txt",
                "type": "string",
              },
            },
            "required": [
              "path",
              "content",
            ],
            "type": "object",
          },
        },
        {
          "name": "append_file",
          "parameters": {
            "properties": {
              "content": {
                "description": "要追加的文本内容",
                "type": "string",
              },
              "path": {
                "description": "相对工作目录的路径，如 notes/log.txt",
                "type": "string",
              },
            },
            "required": [
              "path",
              "content",
            ],
            "type": "object",
          },
        },
        {
          "name": "list_dir",
          "parameters": {
            "properties": {
              "path": {
                "description": "相对工作目录的子目录路径，留空表示工作目录根",
                "type": "string",
              },
            },
            "type": "object",
          },
        },
        {
          "name": "delete_file",
          "parameters": {
            "properties": {
              "path": {
                "description": "相对工作目录的文件路径，如 notes/old.txt",
                "type": "string",
              },
            },
            "required": [
              "path",
            ],
            "type": "object",
          },
        },
        {
          "name": "replace_lines",
          "parameters": {
            "properties": {
              "content": {
                "description": "替换后的新内容（可多行；空字符串等价于删除这些行）",
                "type": "string",
              },
              "end_line": {
                "description": "结束行号（1 起，含）",
                "type": "integer",
              },
              "path": {
                "description": "相对工作目录的文件路径",
                "type": "string",
              },
              "start_line": {
                "description": "起始行号（1 起，含）",
                "type": "integer",
              },
            },
            "required": [
              "path",
              "start_line",
              "end_line",
              "content",
            ],
            "type": "object",
          },
        },
        {
          "name": "insert_lines",
          "parameters": {
            "properties": {
              "content": {
                "description": "要插入的内容（可多行）",
                "type": "string",
              },
              "line": {
                "description": "插入位置行号（1 起，在该行之前插入）",
                "type": "integer",
              },
              "path": {
                "description": "相对工作目录的文件路径",
                "type": "string",
              },
            },
            "required": [
              "path",
              "line",
              "content",
            ],
            "type": "object",
          },
        },
        {
          "name": "delete_lines",
          "parameters": {
            "properties": {
              "end_line": {
                "description": "结束行号（1 起，含）",
                "type": "integer",
              },
              "path": {
                "description": "相对工作目录的文件路径",
                "type": "string",
              },
              "start_line": {
                "description": "起始行号（1 起，含）",
                "type": "integer",
              },
            },
            "required": [
              "path",
              "start_line",
              "end_line",
            ],
            "type": "object",
          },
        },
        {
          "name": "find_files",
          "parameters": {
            "properties": {
              "path": {
                "description": "限定在某子目录下查找（相对工作目录），留空表示整个工作目录",
                "type": "string",
              },
              "pattern": {
                "description": "文件名通配符，如 *.txt",
                "type": "string",
              },
            },
            "required": [
              "pattern",
            ],
            "type": "object",
          },
        },
        {
          "name": "search_in_files",
          "parameters": {
            "properties": {
              "path": {
                "description": "限定在某子目录下搜索（相对工作目录），留空表示整个工作目录",
                "type": "string",
              },
              "query": {
                "description": "要搜索的关键词",
                "type": "string",
              },
            },
            "required": [
              "query",
            ],
            "type": "object",
          },
        },
        {
          "name": "say",
          "parameters": {
            "properties": {
              "display": {
                "description": "把上面的台词翻译成用户显示语言的版本，用于在屏幕上显示。如果你的母语与用户显示语言相同，可以省略此项。",
                "type": "string",
              },
              "voice": {
                "description": "你用母语说出的台词，将被直接送入语音合成。允许可朗读文字、阿拉伯数字、语言正常所需的空格、半角逗号，以及数字常用的小数点、百分号、时间冒号、斜杠和正负号。阿拉伯数字、百分比、日期、时间、版本号、金额和运算式可以保留数字原样，不要为了朗读改写成文字。禁止罗马数字、其他标点、换行、Markdown、emoji、颜文字或特殊符号；网址、路径、代码和缩写仍应改写成适合口头表达的说法。不得包含动作或心理描写。",
                "type": "string",
              },
            },
            "required": [
              "voice",
            ],
            "type": "object",
          },
        },
      ]
    `)
  })
})
