// server/routes/image.js
// 图片去水印路由：LaMa AI修复 → 本地算法兜底
const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const { removeWatermark } = require('../utils/imageInpaint')
const { inpaintByLama } = require('../utils/lamaClient')

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

    // 方案1：LaMa AI 修复，效果最好
    let resultPath
    try {
      resultPath = await inpaintByLama(imagePath, maskPath)
      console.log('[Image] LaMa AI去水印成功')
    } catch (aiErr) {
      // 方案2：LaMa 服务不可用 → 回退本地 inpainting 算法
      console.log(`[Image] LaMa失败(${aiErr.message})，回退本地算法`)
      resultPath = await removeWatermark(imagePath, maskPath)
    }

    const fileName = path.basename(resultPath)
    const resultUrl = `/uploads/${fileName}`

    console.log(`[Image] 去水印完成: ${resultUrl}`)
    res.json({ code: 0, msg: 'success', data: { resultUrl } })
  } catch (err) {
    console.error(`[Image] 处理失败: ${err.message}`)
    res.json({ code: -1, msg: '图片处理失败，请重试', data: null })
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
