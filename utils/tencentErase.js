// server/utils/tencentErase.js
// 腾讯云图像智能 - 去水印 API 封装
const tencentcloud = require('tencentcloud-sdk-nodejs-tiia')
const fs = require('fs')
const path = require('path')

const TiiaClient = tencentcloud.tiia.v20190529.Client

/**
 * 调用腾讯云 RemoveWatermark API 去除图片水印
 * @param {string} imagePath - 本地图片路径
 * @returns {Promise<string>} 处理后图片的本地路径
 */
async function removeWatermarkByApi(imagePath) {
  const secretId = process.env.TENCENT_SECRET_ID
  const secretKey = process.env.TENCENT_SECRET_KEY

  if (!secretId || !secretKey) {
    throw new Error('未配置腾讯云密钥')
  }

  const client = new TiiaClient({
    credential: { secretId, secretKey },
    region: 'ap-guangzhou',
    profile: {
      httpProfile: { endpoint: 'tiia.tencentcloudapi.com' }
    }
  })

  // 读取图片转 base64
  const imageBuffer = fs.readFileSync(imagePath)
  const imageBase64 = imageBuffer.toString('base64')

  // 调用去水印接口
  const result = await client.RemoveWatermark({
    Image: imageBase64
  })

  if (!result || !result.Image) {
    throw new Error('腾讯云返回结果为空')
  }

  // 将结果保存到本地
  const outputDir = path.join(__dirname, '..', 'uploads')
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  const outputPath = path.join(outputDir, `result_${Date.now()}.png`)
  fs.writeFileSync(outputPath, Buffer.from(result.Image, 'base64'))

  return outputPath
}

module.exports = { removeWatermarkByApi }
