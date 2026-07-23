// server/routes/image.js
// 图片去水印路由
const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const { removeWatermark } = require('../utils/imageInpaint')

// POST /api/image/remove-watermark
router.post('/remove-watermark', async (req, res) => {
  try {
    const { imageUrl, maskUrl, width, height } = req.body

    if (!imageUrl || !maskUrl) {
      return res.json({ code: -1, msg: '缺少图片或遮罩参数', data: null })
    }

    console.log(`[Image] 去水印请求: ${imageUrl}`)

    // 将URL转为本地路径（文件通过 /api/upload 上传后返回的URL）
    const imagePath = urlToLocalPath(imageUrl)
    const maskPath = urlToLocalPath(maskUrl)

    if (!fs.existsSync(imagePath)) {
      return res.json({ code: -1, msg: '原图文件不存在', data: null })
    }
    if (!fs.existsSync(maskPath)) {
      return res.json({ code: -1, msg: '遮罩文件不存在', data: null })
    }

    // 执行去水印
    const resultPath = await removeWatermark(imagePath, maskPath)

    // 转为可访问的URL
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
