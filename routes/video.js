// server/routes/video.js
// 视频解析路由
const express = require('express')
const router = express.Router()
const axios = require('axios')
const { parseVideo, isAllowedProxyTarget } = require('../utils/videoParser')
const { headersFor } = require('../utils/mediaFetch')

// POST /api/video/parse
router.post('/parse', async (req, res) => {
  try {
    const { url } = req.body

    if (!url || typeof url !== 'string' || url.length > 2000) {
      return res.json({ code: -1, msg: '请提供有效的视频链接', data: null })
    }

    console.log(`[Video] 解析请求: ${url.slice(0, 200)}`)

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
 * 反向代理：小程序 wx.downloadFile 只能访问白名单域名且不允许自定义 Referer，
 * 各平台 CDN 无法直连。由服务器按平台携带 Referer/UA 请求，再把响应流原样转发，
 * 不落盘、不占用 uploads 空间。用 axios 而非裸 https：抖音等播放地址会先 302 再落 CDN，
 * 需要自动跟随重定向。目标域名受白名单限制，防止被当成任意地址的匿名代理(SSRF)。
 */
router.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url
  if (!targetUrl || !isAllowedProxyTarget(targetUrl)) {
    return res.status(400).json({ code: -1, msg: '非法的代理目标', data: null })
  }

  try {
    const upstream = await axios.get(targetUrl, {
      responseType: 'stream',
      headers: headersFor(targetUrl),
      timeout: 30000,
      maxRedirects: 5,
      beforeRedirect: (options) => {
        const port = options.port ? `:${options.port}` : ''
        const redirectUrl = `${options.protocol}//${options.hostname}${port}${options.path || '/'}`
        if (!isAllowedProxyTarget(redirectUrl)) {
          throw new Error('视频地址重定向到了非白名单域名')
        }
      }
    })

    res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp4')
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length'])
    }
    upstream.data.pipe(res)
    upstream.data.on('error', () => { if (!res.headersSent) res.status(502).end() })
    req.on('close', () => upstream.data.destroy())
  } catch (err) {
    console.error(`[Video] 代理转发失败: ${err.message}`)
    if (!res.headersSent) {
      res.status(502).json({ code: -1, msg: '代理转发失败，链接可能已过期，请重新解析', data: null })
    }
  }
})

module.exports = router
