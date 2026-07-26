// server/routes/video.js
// 视频解析路由
const express = require('express')
const router = express.Router()
const https = require('https')
const { parseVideo, isAllowedProxyTarget } = require('../utils/videoParser')

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

/**
 * GET /api/video/proxy?url=<CDN地址>
 * 反向代理：小程序 wx.downloadFile 不允许自定义 Referer，无法直连B站CDN(会被拒绝)。
 * 由服务器代为携带 Referer 请求，再把响应流原样转发给小程序，不落盘、不占用uploads空间。
 * 仅允许转发 *.bilivideo.com，防止被当成任意地址的匿名代理(SSRF)。
 */
router.get('/proxy', (req, res) => {
  const targetUrl = req.query.url
  if (!targetUrl || !isAllowedProxyTarget(targetUrl)) {
    return res.status(400).json({ code: -1, msg: '非法的代理目标', data: null })
  }

  const upstream = https.get(targetUrl, {
    headers: {
      'Referer': 'https://www.bilibili.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  }, (upstreamRes) => {
    if (upstreamRes.statusCode !== 200) {
      res.status(502).json({ code: -1, msg: `上游返回 ${upstreamRes.statusCode}`, data: null })
      upstreamRes.resume()
      return
    }
    res.setHeader('Content-Type', upstreamRes.headers['content-type'] || 'video/mp4')
    if (upstreamRes.headers['content-length']) {
      res.setHeader('Content-Length', upstreamRes.headers['content-length'])
    }
    upstreamRes.pipe(res)
  })

  upstream.on('error', (err) => {
    console.error(`[Video] 代理转发失败: ${err.message}`)
    if (!res.headersSent) res.status(502).json({ code: -1, msg: '代理转发失败', data: null })
  })

  req.on('close', () => upstream.destroy())
})

module.exports = router
