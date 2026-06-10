/**
 * 音色克隆音频文件上传服务
 *
 * 用途：为 CosyVoice 音色克隆提供音频文件托管服务。
 * 上传的音频文件可通过 URL 直接访问，供 DashScope API 调用。
 *
 * 启动：node server.js
 * 默认端口：3000
 * 上传限制：每个文件最大 50MB
 * 支持格式：wav, mp3, ogg, m4a, flac
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const url = require('url')

// ===================== 配置 =====================
const PORT = parseInt(process.env.PORT, 10) || 3031
const UPLOAD_DIR = path.join(__dirname, 'uploads')
const MAX_FILE_SIZE = 50 * 1024 * 1024  // 50MB
const ALLOWED_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.m4a', '.flac', '.aac', '.webm']
const ALLOWED_MIME_TYPES = [
  'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/mpeg', 'audio/mp3',
  'audio/ogg', 'audio/webm',
  'audio/mp4', 'audio/x-m4a',
  'audio/flac', 'audio/x-flac',
]

// ===================== 确保目录存在 =====================
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

// ===================== 工具函数 =====================

/** 安全的文件名（移除路径遍历、特殊字符） */
function safeFileName(name) {
  // 只保留字母数字、下划线、连字符、点
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').replace(/\.\./g, '_')
}

/** 生成唯一 ID */
function uniqueId() {
  return crypto.randomBytes(8).toString('hex')
}

/** 获取 MIME 类型 */
function getMimeType(ext) {
  const map = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.webm': 'audio/webm',
  }
  return map[ext] || 'application/octet-stream'
}

/** 解析 multipart/form-data 请求体 */
function parseMultipart(buffer, contentType) {
  const boundary = contentType.match(/boundary=(.+)/)?.[1]
  if (!boundary) throw new Error('无法解析 boundary')

  const parts = []
  const boundaryBuffer = Buffer.from(`--${boundary}`)
  const endBoundaryBuffer = Buffer.from(`--${boundary}--`)

  let pos = 0
  while (pos < buffer.length) {
    // 找下一个 boundary
    const start = buffer.indexOf(boundaryBuffer, pos)
    if (start === -1) break

    const end = buffer.indexOf(Buffer.from('\r\n'), start + boundaryBuffer.length)
    if (end === -1) break

    // 确定这个 part 的结束位置
    const nextStart = buffer.indexOf(boundaryBuffer, start + boundaryBuffer.length)
    const partEnd = nextStart !== -1
      ? nextStart - 2  // 减去 \r\n
      : buffer.length - Buffer.from('\r\n').length - endBoundaryBuffer.length

    if (partEnd <= end + 2) break

    // 提取 part 内容（跳过 boundary 行和空行）
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), end)
    if (headerEnd === -1) break

    const rawHeaders = buffer.slice(end + 2, headerEnd).toString()
    const partData = buffer.slice(headerEnd + 4, partEnd)

    // 解析 headers
    const headers = {}
    for (const line of rawHeaders.split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
    }

    // 解析 Content-Disposition
    const disposition = headers['content-disposition'] || ''
    const nameMatch = disposition.match(/name="([^"]+)"/)
    const filenameMatch = disposition.match(/filename="([^"]+)"/)

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: headers['content-type'] || 'text/plain',
      data: partData,
    })

    pos = partEnd + 2
  }

  return parts
}

/** 发送 JSON 响应 */
function jsonResponse(res, status, data) {
  const body = JSON.stringify(data, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(body)
}

/** 发送 HTML 响应 */
function htmlResponse(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
  })
  res.end(html)
}

/** 发送文件响应（支持断点续传 range） */
function sendFile(res, filePath) {
  const stat = fs.statSync(filePath)
  const mimeType = getMimeType(path.extname(filePath))

  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000',
    'Access-Control-Allow-Origin': '*',
  })
  fs.createReadStream(filePath).pipe(res)
}

// ===================== HTML 前端页面 =====================
function getUploadPage() {
  try {
    const fs = require('fs')
    const path = require('path')
    const htmlPath = path.join(__dirname, 'index.html')
    return fs.readFileSync(htmlPath, 'utf-8')
  } catch (e) {
    return '<html><body><h2>❌ index.html 未找到</h2><p>请确保 index.html 文件与 server.js 在同一目录。</p></body></html>'
  }
}

// ===================== HTTP 路由 =====================
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true)
  const pathname = parsedUrl.pathname
  const method = req.method

  // CORS 预检
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  try {
    // ===== 主页 =====
    if (pathname === '/' && method === 'GET') {
      return htmlResponse(res, 200, getUploadPage())
    }

    // ===== 上传文件 POST /api/upload =====
    if (pathname === '/api/upload' && method === 'POST') {
      const contentType = req.headers['content-type'] || ''
      if (!contentType.includes('multipart/form-data')) {
        return jsonResponse(res, 400, { error: '仅支持 multipart/form-data' })
      }

      // 收集请求体
      const chunks = []
      let totalSize = 0
      req.on('data', chunk => {
        chunks.push(chunk)
        totalSize += chunk.length
        if (totalSize > MAX_FILE_SIZE) {
          req.destroy()
        }
      })

      const rawBody = await new Promise((resolve, reject) => {
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
        req.on('close', () => reject(new Error('连接关闭')))
      })

      if (totalSize > MAX_FILE_SIZE) {
        return jsonResponse(res, 413, { error: `文件过大，最大允许 ${MAX_FILE_SIZE / 1024 / 1024}MB` })
      }

      // 解析 multipart
      const parts = parseMultipart(rawBody, contentType)

      // 查找音频文件和 label
      const audioPart = parts.find(p => p.name === 'audio')
      const labelPart = parts.find(p => p.name === 'label')

      if (!audioPart || !audioPart.data.length) {
        return jsonResponse(res, 400, { error: '请选择要上传的音频文件' })
      }

      // 验证文件扩展名
      const ext = path.extname(audioPart.filename || '.wav').toLowerCase()
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return jsonResponse(res, 400, {
          error: `不支持的格式: ${ext}，支持: ${ALLOWED_EXTENSIONS.join(', ')}`,
        })
      }

      // 验证 MIME 类型（宽松验证，仅对非 audio/* 且非未知类型时拒绝）
      if (audioPart.contentType && audioPart.contentType !== 'application/octet-stream') {
        if (!audioPart.contentType.startsWith('audio/') && !ALLOWED_MIME_TYPES.includes(audioPart.contentType)) {
          return jsonResponse(res, 400, { error: `不支持的音频类型: ${audioPart.contentType}` })
        }
      }

      // 生成安全的文件名
      const safeName = safeFileName(path.basename(audioPart.filename || `audio${ext}`))
      const timestamp = Date.now()
      const uniqueName = `${timestamp}_${uniqueId()}${ext}`
      const filePath = path.join(UPLOAD_DIR, uniqueName)

      // 写入文件
      fs.writeFileSync(filePath, audioPart.data)

      // 获取文件大小
      const size = fs.statSync(filePath).size

      // 记录元数据
      const meta = {
        filename: uniqueName,
        originalName: audioPart.filename || uniqueName,
        label: labelPart ? labelPart.data.toString('utf-8').trim() : '',
        size,
        mimeType: audioPart.contentType || getMimeType(ext),
        uploadedAt: Date.now(),
      }

      // 写入元数据文件
      fs.writeFileSync(filePath + '.meta.json', JSON.stringify(meta, null, 2))

      console.log(`[上传] ${meta.originalName} → ${uniqueName} (${(size / 1024).toFixed(1)} KB)`)

      return jsonResponse(res, 200, {
        success: true,
        file: meta,
        url: `/uploads/${uniqueName}`,
        fullUrl: `${req.protocol || 'http'}://${req.headers.host}/uploads/${uniqueName}`,
      })
    }

    // ===== 文件列表 GET /api/files =====
    if (pathname === '/api/files' && method === 'GET') {
      const files = fs.readdirSync(UPLOAD_DIR)
        .filter(f => !f.endsWith('.meta.json'))
        .map(f => {
          const metaPath = path.join(UPLOAD_DIR, f + '.meta.json')
          let meta = { filename: f, originalName: f, label: '', size: 0, uploadedAt: 0 }
          if (fs.existsSync(metaPath)) {
            try {
              meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf-8')) }
            } catch { /* ignore */ }
          }
          if (!meta.size) {
            try { meta.size = fs.statSync(path.join(UPLOAD_DIR, f)).size } catch { meta.size = 0 }
          }
          return meta
        })
        .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))

      return jsonResponse(res, 200, files)
    }

    // ===== 删除文件 DELETE /api/files/:filename =====
    if (pathname.startsWith('/api/files/') && method === 'DELETE') {
      const filename = decodeURIComponent(pathname.slice('/api/files/'.length))
      const filePath = path.join(UPLOAD_DIR, filename)
      const metaPath = filePath + '.meta.json'

      // 防止路径遍历
      if (filename.includes('..') || filename.includes('/')) {
        return jsonResponse(res, 400, { error: '无效的文件名' })
      }

      if (!fs.existsSync(filePath)) {
        return jsonResponse(res, 404, { error: '文件不存在' })
      }

      fs.unlinkSync(filePath)
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath)

      console.log(`[删除] ${filename}`)
      return jsonResponse(res, 200, { success: true, message: '已删除' })
    }

    // ===== 下载/访问文件 GET /uploads/:filename =====
    if (pathname.startsWith('/uploads/')) {
      const filename = decodeURIComponent(pathname.slice('/uploads/'.length))
      const filePath = path.join(UPLOAD_DIR, filename)

      if (filename.includes('..') || filename.includes('/')) {
        return jsonResponse(res, 400, { error: '无效的文件路径' })
      }

      if (!fs.existsSync(filePath)) {
        return htmlResponse(res, 404, `<h2>404 - 文件不存在</h2><p>${escapeHtml(filename)}</p>`)
      }

      return sendFile(res, filePath)
    }

    // ===== 404 =====
    jsonResponse(res, 404, { error: '未找到', path: pathname })
  } catch (e) {
    console.error('[错误]', e)
    jsonResponse(res, 500, { error: e.message || '服务器内部错误' })
  }
})

// ===================== 启动 =====================
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║       🎙️ CosyVoice 音色克隆文件上传服务       ║
╠══════════════════════════════════════════════╣
║  地址:  http://localhost:${PORT}                ║
║  上传:  POST /api/upload                     ║
║  列表:  GET  /api/files                      ║
║  文件:  GET  /uploads/<文件名>                ║
║  删除:  DELETE /api/files/<文件名>            ║
║                                              ║
║  上传目录: ${UPLOAD_DIR}              ║
║  允许格式: ${ALLOWED_EXTENSIONS.join(', ')}    ║
║  大小限制: ${MAX_FILE_SIZE / 1024 / 1024}MB                 ║
╚══════════════════════════════════════════════╝
`)
})
