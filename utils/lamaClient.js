// server/utils/lamaClient.js
// 石榴智能「手动去水印/图片修复」API 客户端
// 文档: https://shiliuai.com/api/qushuiyin
// 按次计费(1积分/次)，图片以 base64 传给第三方服务器处理
const https = require('https')
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const API_HOST = 'api.shiliuai.com'
const API_PATH = '/api/inpaint/v1'
const API_KEY = process.env.SHILIU_API_KEY

/**
 * 调用石榴智能 inpaint 接口修复图片。
 * @param {string} imagePath - 原图本地路径
 * @param {string} maskPath - 前端 canvas 导出的涂抹遮罩本地路径
 *   (半透明红色描边 rgba(255,80,80,0.5)，透明底 —— 与本地算法共用同一份遮罩)
 * @returns {Promise<string>} 结果图本地路径
 */
async function inpaintByLama(imagePath, maskPath) {
  if (!API_KEY) {
    throw new Error('未配置 SHILIU_API_KEY 环境变量')
  }

  const imageBase64 = fs.readFileSync(imagePath).toString('base64')
  // 石榴API要求黑白灰度mask(白=待修复/黑=保留)，前端导出的是半透明红色描边+透明底，需转换
  const maskBase64 = await buildGrayscaleMask(maskPath, imagePath)

  const payload = JSON.stringify({
    image_base64: imageBase64,
    mask_base64: maskBase64
  })

  const body = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API_HOST,
      path: API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'APIKEY': API_KEY,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 55000 // 云托管网关 60s 硬超时，留 5s 余量提前失败转入本地回退
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ statusCode: res.statusCode, data }))
      res.on('error', reject)
    })

    req.on('error', (err) => reject(new Error(`石榴API连接失败: ${err.message}`)))
    req.on('timeout', () => { req.destroy(); reject(new Error('石榴API超时')) })
    req.write(payload)
    req.end()
  })

  let result
  try {
    result = JSON.parse(body.data)
  } catch {
    throw new Error(`石榴API返回非JSON(HTTP ${body.statusCode}): ${body.data.slice(0, 200)}`)
  }

  if (result.code !== 0 || !result.result_base64) {
    throw new Error(result.msg_cn || result.msg || `石榴API错误(code=${result.code})`)
  }

  const outputDir = path.join(__dirname, '..', 'uploads')
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  const outputPath = path.join(outputDir, `result_${Date.now()}.jpg`)
  fs.writeFileSync(outputPath, Buffer.from(result.result_base64, 'base64'))

  return outputPath
}

/**
 * 把前端 canvas 导出的半透明红色涂抹图转成石榴API要的黑白灰度mask。
 * 判定逻辑跟本地算法(imageInpaint.js 的 parseBrushMask)保持一致：
 * 红色占主导且有一定不透明度 = 用户涂抹处 → 白色(255)；其余 → 黑色(0)。
 * @returns {Promise<string>} mask 的 base64 编码(PNG)
 */
async function buildGrayscaleMask(maskPath, imagePath) {
  const { width, height } = await sharp(imagePath).metadata()
  const maskBuffer = await sharp(maskPath)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer()

  const gray = Buffer.alloc(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = maskBuffer[i * 4]
    const g = maskBuffer[i * 4 + 1]
    const b = maskBuffer[i * 4 + 2]
    const a = maskBuffer[i * 4 + 3]
    gray[i] = (a > 20 && r > 100 && r > g * 1.5 && r > b * 1.5) ? 255 : 0
  }

  // 显式指定灰度色彩空间，否则 sharp 默认输出会转成 3 通道 RGB PNG
  const png = await sharp(gray, { raw: { width, height, channels: 1 } })
    .toColorspace('b-w')
    .png()
    .toBuffer()
  return png.toString('base64')
}

module.exports = { inpaintByLama }
