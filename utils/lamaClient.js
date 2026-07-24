// server/utils/lamaClient.js
// IOPaint 图像修复服务客户端（支持 MAT/LaMa 等模型）
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

// IOPaint 服务地址
const INPAINT_BASE = process.env.LAMA_SERVICE_URL || 'http://localhost:8000'

/**
 * 调用 IOPaint 服务进行图像修复
 * IOPaint API 接受 base64 编码的 JSON 请求
 * @param {string} imagePath - 原图本地路径
 * @param {string} maskPath - 遮罩图本地路径
 * @returns {Promise<string>} 结果图本地路径
 */
async function inpaintByLama(imagePath, maskPath) {
  const imageBuffer = fs.readFileSync(imagePath)
  const maskBuffer = fs.readFileSync(maskPath)

  const payload = JSON.stringify({
    image: imageBuffer.toString('base64'),
    mask: maskBuffer.toString('base64')
  })

  const url = new URL(`${INPAINT_BASE}/api/v1/inpaint`)
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 180000
    }, (res) => {
      if (res.statusCode !== 200) {
        let errData = ''
        res.on('data', chunk => errData += chunk)
        res.on('end', () => reject(new Error(`Inpaint服务返回 ${res.statusCode}: ${errData}`)))
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

    req.on('error', (err) => reject(new Error(`Inpaint服务连接失败: ${err.message}`)))
    req.on('timeout', () => { req.destroy(); reject(new Error('Inpaint服务超时')) })
    req.write(payload)
    req.end()
  })
}

module.exports = { inpaintByLama }
