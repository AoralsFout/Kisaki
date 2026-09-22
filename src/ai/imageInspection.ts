/** 把嵌入图片 data URL 转成检查视图可安全展示的元数据。 */
export function redactEmbeddedImageDataUrl(url: string): string {
  if (!url.startsWith('data:')) return url
  const match = url.match(/^data:([^;,]+)(?:;base64)?,(.*)$/s)
  const mime = match?.[1] || 'application/octet-stream'
  const encodedLength = match?.[2]?.length ?? 0
  const approximateBytes = Math.max(0, Math.floor(encodedLength * 0.75))
  return `[embedded image: ${mime}, approximately ${approximateBytes} bytes]`
}
