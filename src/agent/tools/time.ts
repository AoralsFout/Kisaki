/**
 * 时间工具 - 获取当前日期和时间
 */
import type { Tool } from '../types'
import { createLogger } from '../../utils/logger'

const log = createLogger('ToolTime')

export const timeTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_time',
      description: '获取当前日期和时间，包括年、月、日、星期、时、分',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: '时区，如 Asia/Shanghai、America/New_York，默认为本地时区',
          },
        },
      },
    },
  },
  handler: async (args) => {
    const tz = args.timezone as string | undefined
    const now = new Date()

    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: tz || undefined,
    }

    const formatted = new Intl.DateTimeFormat('zh-CN', options).format(now)
    const weekdays = ['日', '一', '二', '三', '四', '五', '六']
    const dayOfWeek = weekdays[now.getDay()]

    log.debug('查询时间: %s (时区: %s)', formatted, tz || '本地')
    return `当前时间：${formatted}（星期${dayOfWeek}）`
  },
}
