// server/routes/video.js
// 视频解析路由
const express = require('express')
const router = express.Router()
const { parseVideo } = require('../utils/videoParser')

// POST /api/video/parse
router.post('/parse', async (req, res) => {
  try {
    const { url } = req.body

    if (!url || typeof url !== 'string') {
      return res.json({ code: -1, msg: '请提供有效的视频链接', data: null })
    }

    console.log(`[Video] 解析请求: ${url}`)

    const result = await parseVideo(url)

    console.log(`[Video] 解析成功: ${result.title}`)
    res.json({ code: 0, msg: 'success', data: result })
  } catch (err) {
    console.error(`[Video] 解析失败: ${err.message}`)
    res.json({ code: -1, msg: err.message || '解析失败', data: null })
  }
})

module.exports = router
