// server/routes/image.js
// 图片去水印路由：阿里云智能消除 → 腾讯云 → 本地算法
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

// uploads 目录绝对路径，用于路径穿越校验
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

// POST /api/image/remove-watermark
router.post('/remove-watermark', async (req, res) => {
  try {
    const { imageUrl, maskUrl } = req.body

    if (!imageUrl || !maskUrl) {
      return res.json({ code: -1, msg: '缺少图片或遮罩参数', data: null })
    }

    console.log(`[Image] 去水印请求: ${imageUrl}`)

    const imagePath = urlToLocalPath(imageUrl)
    const maskPath = urlToLocalPath(maskUrl)

    if (!imagePath || !maskPath) {
      return res.json({ code: -1, msg: '非法的文件路径', data: null })
    }
    if (!fs.existsSync(imagePath)) {
      return res.json({ code: -1, msg: '原图文件不存在', data: null })
    }
    if (!fs.existsSync(maskPath)) {
      return res.json({ code: -1, msg: '遮罩文件不存在', data: null })
    }

    let resultPath = null

    // 方案1：阿里云智能消除（效果最好）
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
 * 将 /uploads/xxx 格式的URL转为本地文件路径。
 * 严格限制在 uploads 目录内，防止路径穿越。
 */
function urlToLocalPath(url) {
  let pathname
  if (url.startsWith('/uploads/')) {
    pathname = url
  } else if (url.startsWith('http')) {
    try {
      pathname = new URL(url).pathname
    } catch {
      return null
    }
  } else {
    return null
  }

  const fileName = path.basename(decodeURIComponent(pathname))
  const resolved = path.join(UPLOADS_DIR, fileName)

  if (path.relative(UPLOADS_DIR, resolved).startsWith('..')) {
    return null
  }
  return resolved
}

module.exports = router
