// server/utils/lamaClient.js
// LaMa 图像修复服务客户端
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

// LaMa 服务地址（云托管内网或公网）
const LAMA_BASE = process.env.LAMA_SERVICE_URL || 'http://localhost:8000'

/**
 * 调用 LaMa 服务进行图像修复
 * @param {string} imagePath - 原图本地路径
 * @param {string} maskPath - 遮罩图本地路径
 * @returns {Promise<string>} 结果图本地路径
 */
async function inpaintByLama(imagePath, maskPath) {
  const boundary = '----FormBoundary' + Date.now().toString(36)

  const imageBuffer = fs.readFileSync(imagePath)
  const maskBuffer = fs.readFileSync(maskPath)

  const imageFileName = path.basename(imagePath)
  const maskFileName = path.basename(maskPath)

  // 构造 multipart/form-data 请求体
  const parts = []

  parts.push(`--${boundary}\r\n`)
  parts.push(`Content-Disposition: form-data; name="image"; filename="${imageFileName}"\r\n`)
  parts.push(`Content-Type: image/jpeg\r\n\r\n`)

  const middle = `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="mask"; filename="${maskFileName}"\r\n` +
    `Content-Type: image/png\r\n\r\n`

  const end = `\r\n--${boundary}--\r\n`

  const bodyBuffer = Buffer.concat([
    Buffer.from(parts.join('')),
    imageBuffer,
    Buffer.from(middle),
    maskBuffer,
    Buffer.from(end)
  ])

  const url = new URL(`${LAMA_BASE}/api/inpaint`)
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length
      },
      timeout: 180000
    }, (res) => {
      if (res.statusCode !== 200) {
        let errData = ''
        res.on('data', chunk => errData += chunk)
        res.on('end', () => reject(new Error(`LaMa服务返回 ${res.statusCode}: ${errData}`)))
        return
      }

      // 保存返回的图片
      const outputDir = path.join(__dirname, '..', 'uploads')
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }
      const outputPath = path.join(outputDir, `result_${Date.now()}.png`)
      const fileStream = fs.createWriteStream(outputPath)

      res.pipe(fileStream)
      fileStream.on('finish', () => {
        fileStream.close()
        resolve(outputPath)
      })
      fileStream.on('error', reject)
    })

    req.on('error', (err) => reject(new Error(`LaMa服务连接失败: ${err.message}`)))
    req.on('timeout', () => { req.destroy(); reject(new Error('LaMa服务超时')) })
    req.write(bodyBuffer)
    req.end()
  })
}

module.exports = { inpaintByLama }
