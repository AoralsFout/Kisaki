/**
 * 计算器工具 - 执行数学计算
 *
 * 安全的表达式求值，仅支持基础数学运算。
 */
import type { Tool } from '../types'

/** 安全表达式求值 */
function safeEval(expr: string): number {
  // 只允许数字、运算符、括号、小数点、空格
  const sanitized = expr.replace(/\s/g, '')
  if (!/^[\d+\-*/().%^,]+$/.test(sanitized)) {
    throw new Error('表达式包含非法字符')
  }

  // 将 ^ 替换为 ** (幂运算)
  const prepared = sanitized.replace(/\^/g, '**')

  // 使用 Function 代替 eval (在严格模式下更安全)
  const fn = new Function(`"use strict"; return (${prepared})`)
  const result = fn()

  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error('计算结果无效')
  }

  return Math.round(result * 1e10) / 1e10
}

export const calculatorTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'calculator',
      description: '执行数学计算，支持加减乘除、幂运算、括号。例如: (3.5 + 4) * 2, 2^10, 100/3',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '数学表达式，如 "3.5 * 4 + 2" 或 "(15 + 3) / 2"',
          },
        },
        required: ['expression'],
      },
    },
  },
  handler: async (args) => {
    const expr = String(args.expression ?? '')
    if (!expr.trim()) return '请提供数学表达式'

    try {
      const result = safeEval(expr)
      return `${expr} = ${result}`
    } catch (err) {
      return `计算错误: ${(err as Error).message}`
    }
  },
}
