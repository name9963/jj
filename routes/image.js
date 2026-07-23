// server/routes/image.js
// 图片去水印路由
const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const { removeWatermark } = require('../utils/imageInpaint')
const { removeWatermarkByApi } = require('../utils/tencentErase')
const { removeWatermarkAndSave } = require('../utils/aliyunErase')

// 云托管公网域名（用于拼接图片的公网URL给阿里云API）
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN ||
  'https://express-vyz1-286021-10-1457360213.sh.run.tcloudbase.com'

// POST /api/image/remove-watermark
router.post('/remove-watermark', async (req, res) => {
  try {
    const { imageUrl, maskUrl, width, height } = req.body

    if (!imageUrl || !maskUrl) {
      return res.json({ code: -1, msg: '缺少图片或遮罩参数', data: null })
    }

    console.log(`[Image] 去水印请求: ${imageUrl}`)

    const imagePath = urlToLocalPath(imageUrl)
    const maskPath = urlToLocalPath(maskUrl)

    if (!fs.existsSync(imagePath)) {
      return res.json({ code: -1, msg: '原图文件不存在', data: null })
    }
    if (!fs.existsSync(maskPath)) {
      return res.json({ code: -1, msg: '遮罩文件不存在', data: null })
    }

    let resultPath = null

    // 方案1：阿里云智能消除（效果最好，支持透明字块/文字识别消除）
    try {
      const publicUrl = `${PUBLIC_DOMAIN}${imageUrl}`
      resultPath = await removeWatermarkAndSave(publicUrl)
      console.log(`[Image] 阿里云AI去水印成功`)
    } catch (aliErr) {
      console.log(`[Image] 阿里云API失败(${aliErr.message})`)

      // 方案2：腾讯云去水印
      try {
        resultPath = await removeWatermarkByApi(imagePath)
        console.log(`[Image] 腾讯云API去水印成功`)
      } catch (txErr) {
        console.log(`[Image] 腾讯云API失败(${txErr.message})，回退本地算法`)

        // 方案3：本地 inpainting 算法
        resultPath = await removeWatermark(imagePath, maskPath)
      }
    }

    const fileName = path.basename(resultPath)
    const resultUrl = `/uploads/${fileName}`

    console.log(`[Image] 去水印完成: ${resultUrl}`)
    res.json({ code: 0, msg: 'success', data: { resultUrl } })
  } catch (err) {
    console.error(`[Image] 处理失败: ${err.message}`)
    res.json({ code: -1, msg: err.message || '处理失败', data: null })
  }
})

/**
 * 将 /uploads/xxx 格式的URL转为本地文件路径
 */
function urlToLocalPath(url) {
  if (url.startsWith('/uploads/')) {
    return path.join(__dirname, '..', url)
  }
  if (url.startsWith('http')) {
    // 提取路径部分
    const urlObj = new URL(url)
    return path.join(__dirname, '..', urlObj.pathname)
  }
  return url
}

module.exports = router
