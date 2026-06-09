/**
 * 计算器工具 - 执行数学计算
 *
 * 使用递归下降解析器安全求值，不依赖 eval / new Function。
 */
import type { Tool } from '../types'

// ==================== 词法分析 ====================

type Token =
  | { type: 'number'; value: number }
  | { type: 'op'; value: string }
  | { type: 'paren'; value: '(' | ')' }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (/\s/.test(ch)) { i++; continue }
    if (/\d/.test(ch) || ch === '.') {
      let num = ''
      while (i < input.length && (/\d/.test(input[i]) || input[i] === '.')) {
        num += input[i++]
      }
      const val = parseFloat(num)
      if (isNaN(val)) throw new Error(`无效数字: "${num}"`)
      tokens.push({ type: 'number', value: val })
      continue
    }
    if ('+-*/%^()'.includes(ch)) {
      if (ch === '(' || ch === ')') {
        tokens.push({ type: 'paren', value: ch as '(' | ')' })
      } else {
        tokens.push({ type: 'op', value: ch })
      }
      i++
      continue
    }
    throw new Error(`非法字符: "${ch}"`)
  }
  return tokens
}

// ==================== 递归下降解析器 ====================
// 文法:
//   expr     → term (('+' | '-') term)*
//   term     → factor (('*' | '/' | '%') factor)*
//   factor   → base ('^' factor)?
//   base     → number | '(' expr ')' | '-' factor

class Parser {
  private tokens: Token[]
  private pos = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : null
  }

  private consume(): Token {
    const tok = this.peek()
    if (!tok) throw new Error('表达式不完整')
    this.pos++
    return tok
  }

  parse(): number {
    const result = this.expr()
    if (this.peek()) throw new Error('表达式末尾有多余内容')
    return result
  }

  /** expr → term (('+' | '-') term)* */
  private expr(): number {
    let left = this.term()
    while (this.peek()?.type === 'op' && (this.peek() as any).value === '+' || this.peek()?.type === 'op' && (this.peek() as any).value === '-') {
      const op = (this.consume() as any).value
      const right = this.term()
      left = op === '+' ? left + right : left - right
    }
    return left
  }

  /** term → factor (('*' | '/' | '%') factor)* */
  private term(): number {
    let left = this.factor()
    while (
      this.peek()?.type === 'op' &&
      ['*', '/', '%'].includes((this.peek() as any).value)
    ) {
      const op = (this.consume() as any).value
      const right = this.factor()
      if (op === '*') left = left * right
      else if (op === '/') {
        if (right === 0) throw new Error('除数不能为 0')
        left = left / right
      }
      else left = left % right
    }
    return left
  }

  /** factor → base ('^' factor)?  右结合 */
  private factor(): number {
    let base = this.base()
    if (this.peek()?.type === 'op' && (this.peek() as any).value === '^') {
      this.consume()
      const exp = this.factor()  // 递归实现右结合
      base = Math.pow(base, exp)
    }
    return base
  }

  /** base → number | '(' expr ')' | '-' factor */
  private base(): number {
    const tok = this.peek()
    if (!tok) throw new Error('表达式不完整')

    // 负号（一元运算符）
    if (tok.type === 'op' && tok.value === '-') {
      this.consume()
      return -this.factor()
    }

    if (tok.type === 'number') {
      this.consume()
      return tok.value
    }

    if (tok.type === 'paren' && tok.value === '(') {
      this.consume() // 吃掉 '('
      const val = this.expr()
      const closing = this.peek()
      if (!closing || closing.type !== 'paren' || (closing as any).value !== ')') {
        throw new Error('缺少右括号')
      }
      this.consume() // 吃掉 ')'
      return val
    }

    throw new Error(`意外的语法: ${JSON.stringify(tok)}`)
  }
}

/** 安全表达式求值 */
function safeEval(expr: string): number {
  const tokens = tokenize(expr)
  if (tokens.length === 0) throw new Error('表达式为空')
  const parser = new Parser(tokens)
  const result = parser.parse()
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
