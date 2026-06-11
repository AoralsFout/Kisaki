/**
 * 计算器工具单元测试
 *
 * 覆盖 tokenize、Parser、safeEval 及 calculatorTool handler
 */
import { describe, it, expect } from 'vitest'

// 为了测试内部函数，我们复制模块中的函数签名并动态导入
// 但更干净的方案：导出内部函数供测试，但当前模块只导出了 calculatorTool
// 这里通过导入整个模块来测试 handler，内部逻辑通过 handler 间接覆盖
import { calculatorTool } from '../calculator'

// ─── 辅助函数：从 handler 返回值中提取结果数字 ──────────

function evalExpr(expr: string): string {
  // 由于 handler 是 async，这里用 Promise 包装
  return calculatorTool.handler({ expression: expr }) as Promise<string>
}

describe('Calculator Tool - Handler', () => {
  it('基本加法', async () => {
    const result = await evalExpr('1 + 2')
    expect(result).toBe('1 + 2 = 3')
  })

  it('基本减法', async () => {
    const result = await evalExpr('10 - 3')
    expect(result).toBe('10 - 3 = 7')
  })

  it('基本乘法', async () => {
    const result = await evalExpr('4 * 5')
    expect(result).toBe('4 * 5 = 20')
  })

  it('基本除法', async () => {
    const result = await evalExpr('20 / 4')
    expect(result).toBe('20 / 4 = 5')
  })

  it('取模运算', async () => {
    const result = await evalExpr('10 % 3')
    expect(result).toBe('10 % 3 = 1')
  })

  it('幂运算', async () => {
    const result = await evalExpr('2 ^ 10')
    expect(result).toBe('2 ^ 10 = 1024')
  })

  it('带括号的复合表达式', async () => {
    const result = await evalExpr('(3.5 + 4) * 2')
    expect(result).toBe('(3.5 + 4) * 2 = 15')
  })

  it('多层括号嵌套', async () => {
    const result = await evalExpr('((1 + 2) * (3 + 4))')
    expect(result).toBe('((1 + 2) * (3 + 4)) = 21')
  })

  it('运算符优先级: 乘除优先于加减', async () => {
    const result = await evalExpr('2 + 3 * 4')
    expect(result).toBe('2 + 3 * 4 = 14')
  })

  it('小数运算', async () => {
    const result = await evalExpr('0.1 + 0.2')
    // 由于浮点精度，0.1+0.2=0.3000000000...，但 safeEval 四舍五入到 1e-10
    expect(result).toMatch(/^0\.1 \+ 0\.2 = 0\.3/)
  })

  it('整除', async () => {
    const result = await evalExpr('100 / 3')
    expect(result).toBe('100 / 3 = 33.3333333333')
  })

  it('幂运算右结合', async () => {
    const result = await evalExpr('2 ^ 3 ^ 2')
    // 右结合: 2^(3^2) = 2^9 = 512
    expect(result).toBe('2 ^ 3 ^ 2 = 512')
  })

  it('一元负号', async () => {
    const result = await evalExpr('-5 + 3')
    expect(result).toBe('-5 + 3 = -2')
  })

  it('负号与括号', async () => {
    const result = await evalExpr('-(3 + 4)')
    expect(result).toBe('-(3 + 4) = -7')
  })

  it('连续负号', async () => {
    const result = await evalExpr('--5')
    expect(result).toBe('--5 = 5')
  })

  it('表达式中的空格', async () => {
    const result = await evalExpr('  3   +   4  ')
    // 保留原表达式中的空格拼接 " = 结果"
    expect(result).toBe('  3   +   4   = 7')
  })

  it('复杂混合表达式', async () => {
    const result = await evalExpr('(2 + 3) * 4 ^ 2 / 2 - 1')
    // (5) * 16 / 2 - 1 = 40 - 1 = 39
    expect(result).toBe('(2 + 3) * 4 ^ 2 / 2 - 1 = 39')
  })
})

describe('Calculator Tool - Error Handling', () => {
  it('空表达式', async () => {
    const result = await evalExpr('')
    expect(result).toBe('请提供数学表达式')
  })

  it('仅空格', async () => {
    const result = await evalExpr('   ')
    expect(result).toBe('请提供数学表达式')
  })

  it('表达式不完整', async () => {
    const result = await evalExpr('3 +')
    expect(result).toBe('计算错误: 表达式不完整')
  })

  it('除数为 0', async () => {
    const result = await evalExpr('5 / 0')
    expect(result).toBe('计算错误: 除数不能为 0')
  })

  it('非法字符', async () => {
    const result = await evalExpr('3 + @')
    expect(result).toBe('计算错误: 非法字符: "@"')
  })

  it('缺少右括号', async () => {
    const result = await evalExpr('(3 + 4')
    expect(result).toBe('计算错误: 缺少右括号')
  })

  it('多余内容', async () => {
    const result = await evalExpr('3 + 4 5')
    expect(result).toBe('计算错误: 表达式末尾有多余内容')
  })

  it('连续运算符', async () => {
    const result = await evalExpr('3 ++ 4')
    expect(result).toBe('计算错误: 意外的语法: {"type":"op","value":"+"}')
  })

  it('不带参数的调用', async () => {
    // 测试 handler 在 args 缺失 expression 时的情况
    const result = await calculatorTool.handler({})
    expect(result).toBe('请提供数学表达式')
  })
})

describe('Calculator Tool - Edge Cases', () => {
  it('单个数字', async () => {
    const result = await evalExpr('42')
    expect(result).toBe('42 = 42')
  })

  it('单个负数', async () => {
    const result = await evalExpr('-42')
    expect(result).toBe('-42 = -42')
  })

  it('大数字', async () => {
    const result = await evalExpr('999999 * 1')
    expect(result).toBe('999999 * 1 = 999999')
  })

  it('幂运算底数为 0', async () => {
    const result = await evalExpr('0 ^ 5')
    expect(result).toBe('0 ^ 5 = 0')
  })

  it('幂运算指数为 0', async () => {
    const result = await evalExpr('5 ^ 0')
    expect(result).toBe('5 ^ 0 = 1')
  })

  it('括号内负号', async () => {
    const result = await evalExpr('(-3)')
    expect(result).toBe('(-3) = -3')
  })

  it('多层嵌套负号与括号', async () => {
    const result = await evalExpr('-(-(4))')
    expect(result).toBe('-(-(4)) = 4')
  })
})
