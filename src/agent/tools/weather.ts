/**
 * 天气工具 - 查询天气
 *
 * 使用 wttr.in（免费，无需 API Key）
 */
import type { Tool } from '../types'
import { createLogger } from '../../utils/logger'

const log = createLogger('ToolWeather')

export const weatherTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询指定城市的当前天气和未来预报，包括温度、天气状况、湿度、风速等',
      parameters: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: '城市名，如 北京、上海、Tokyo、London',
          },
          days: {
            type: 'number',
            description: '预报天数（1-3），默认为1（仅当天）',
          },
        },
        required: ['city'],
      },
    },
  },
  handler: async (args) => {
    const city = String(args.city)
    const days = Math.min(Math.max(Number(args.days) || 1, 1), 3)
    log.debug('查询天气: %s (%d 天)', city, days)

    try {
      const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`, {
        signal: AbortSignal.timeout(8000),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      const current = data.current_condition?.[0]
      const forecast = data.weather?.slice(0, days) ?? []

      if (!current) {
        log.warn('未获取到天气数据: %s', city)
        return `无法获取 "${city}" 的天气信息`
      }

      let result = `🌍 ${city} 天气\n`
      result += `🌡️ 当前: ${current.temp_C}°C (体感 ${current.FeelsLikeC}°C)\n`
      result += `☁️ ${current.weatherDesc?.[0]?.value ?? '未知'}\n`
      result += `💧 湿度: ${current.humidity}%\n`
      result += `💨 风速: ${current.windspeedKmph}km/h\n`

      for (const day of forecast) {
        const date = day.date ?? ''
        const maxTemp = day.tempMaxC ?? '-'
        const minTemp = day.tempMinC ?? '-'
        const desc = day.hourly?.[0]?.weatherDesc?.[0]?.value ?? ''
        result += `\n📅 ${date}: ${desc} ${minTemp}~${maxTemp}°C`
      }

      log.info('天气查询成功: %s - %s°C', city, current.temp_C)
      return result
    } catch (err) {
      if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
        log.warn('天气查询超时: %s', city)
        return `查询 "${city}" 天气超时，请稍后重试`
      }
      log.warn('天气查询失败: %s - %s', city, (err as Error).message)
      return `查询天气失败: ${(err as Error).message}`
    }
  },
}
