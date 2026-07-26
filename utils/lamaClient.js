// server/utils/lamaClient.js
// IOPaint 图像修复服务客户端（支持 MAT/LaMa 等模型）
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

// IOPaint 服务地址
const INPAINT_BASE = process.env.LAMA_SERVICE_URL || 'http://localhost:8000'

// 推理最大边长（缩小以加速，避免网关超时）
const MAX_SIDE = 512

/**
 * 调用 IOPaint 服务进行图像修复
 * 先缩小图片加速推理，处理完再放大回原尺寸
 * @param {string} imagePath - 原图本地路径
 * @param {string} maskPath - 遮罩图本地路径
 * @returns {Promise<string>} 结果图本地路径
 */
async function inpaintByLama(imagePath, maskPath) {
  // 读取原图获取尺寸
  const imageMeta = await sharp(imagePath).metadata()
  const origWidth = imageMeta.width
  const origHeight = imageMeta.height

  // 缩小到最大边 MAX_SIDE
  let procImageBuffer, procMaskBuffer
  const needResize = Math.max(origWidth, origHeight) > MAX_SIDE

  if (needResize) {
    procImageBuffer = await sharp(imagePath)
      .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
    procMaskBuffer = await sharp(maskPath)
      .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
  } else {
    procImageBuffer = fs.readFileSync(imagePath)
    procMaskBuffer = fs.readFileSync(maskPath)
  }

  const payload = JSON.stringify({
    image: procImageBuffer.toString('base64'),
    mask: procMaskBuffer.toString('base64')
  })

  const url = new URL(`${INPAINT_BASE}/api/v1/inpaint`)
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http

  const resultBuffer = await new Promise((resolve, reject) => {
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

      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })

    req.on('error', (err) => reject(new Error(`Inpaint服务连接失败: ${err.message}`)))
    req.on('timeout', () => { req.destroy(); reject(new Error('Inpaint服务超时')) })
    req.write(payload)
    req.end()
  })

  // 如果之前缩小了，把结果放大回原尺寸
  let finalBuffer = resultBuffer
  if (needResize) {
    finalBuffer = await sharp(resultBuffer)
      .resize(origWidth, origHeight, { fit: 'fill' })
      .png()
      .toBuffer()
  }

  // 保存结果
  const outputDir = path.join(__dirname, '..', 'uploads')
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  const outputPath = path.join(outputDir, `result_${Date.now()}.png`)
  fs.writeFileSync(outputPath, finalBuffer)

  return outputPath
}

module.exports = { inpaintByLama }
