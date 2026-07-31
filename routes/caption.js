// server/routes/caption.js
// 视频口播文案提取（把视频里说的话转成文字）：异步任务模式，避免云托管网关 60s 超时
//
// 两种来源：
//   1) 分享链接：{ link: 'https://v.douyin.com/xxx' } —— 服务端解析后自己下载视频再识别
//   2) 本地视频：小程序先走 /api/upload 上传，再传 { videoUrl: '/uploads/xxx.mp4' }
//
// 统一流程：POST /extract 建任务立即返回 taskId → 后台 ffmpeg 抽音轨 + whisper.cpp 识别
//          → 小程序轮询 GET /result/:taskId 拿文字
const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const { transcribeVideo, MAX_SECONDS } = require('../utils/asrClient')
const { transcribeByParaformer, isParaformerEnabled } = require('../utils/paraformerClient')
const { downloadVideo } = require('../utils/mediaFetch')
const { parseVideo } = require('../utils/videoParser')
const { isCloudFileID, downloadCloudFile } = require('../utils/cloudStorage')

// uploads 目录绝对路径，用于路径穿越校验
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

// 任务存储（内存中，单实例足够；与 image 路由一致）。
// 云托管锁 1/1 单实例，提交与轮询始终在同一进程；不引入外部 DB 依赖。
const tasks = new Map()

// 语音识别很吃 CPU，限制并发，超出直接让用户稍后再试
let running = 0
const MAX_RUNNING = Number(process.env.ASR_MAX_CONCURRENCY || 1)

// POST /api/caption/extract
// body: { link } 或 { videoUrl }
router.post('/extract', (req, res) => {
  const { link, videoUrl } = req.body || {}

  if (!link && !videoUrl) {
    return res.json({ code: -1, msg: '请提供视频链接或先上传视频', data: null })
  }
  if ((link && (typeof link !== 'string' || link.length > 2000)) ||
      (videoUrl && (typeof videoUrl !== 'string' || videoUrl.length > 500))) {
    return res.json({ code: -1, msg: '视频地址参数无效', data: null })
  }
  if (running >= MAX_RUNNING) {
    return res.json({ code: -1, msg: '当前识别任务较多，请稍后再试', data: null })
  }

  // 本地上传的视频：云存储 fileID(cloud://，B+) 或 /uploads 路径(旧方案)
  let uploadedPath = null
  let cloudVideoId = null
  if (!link) {
    if (isCloudFileID(videoUrl)) {
      cloudVideoId = videoUrl
    } else {
      uploadedPath = urlToLocalPath(videoUrl)
      if (!uploadedPath) {
        return res.json({ code: -1, msg: '非法的文件路径', data: null })
      }
      if (!fs.existsSync(uploadedPath)) {
        return res.json({ code: -1, msg: '视频文件不存在，请重新上传', data: null })
      }
    }
  }

  const taskId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  tasks.set(taskId, { status: 'processing', text: null, error: null })

  console.log(`[Caption] 口播识别任务创建: ${taskId}, 来源: ${link ? '链接 ' + link.slice(0, 60) : (cloudVideoId ? '云存储视频' : videoUrl)}`)

  // 立即返回 taskId
  res.json({ code: 0, msg: 'success', data: { taskId, maxSeconds: MAX_SECONDS } })

  // 后台异步处理（只做语音识别：Paraformer 优先，whisper 兑底）
  processTranscribe(taskId, { link, uploadedPath, cloudVideoId })
})

// GET /api/caption/result/:taskId
// 轮询任务结果
router.get('/result/:taskId', (req, res) => {
  const { taskId } = req.params
  const task = tasks.get(taskId)

  if (!task) {
    return res.json({ code: -1, msg: '任务不存在或已过期', data: null })
  }

  if (task.status === 'processing') {
    return res.json({ code: 0, msg: 'processing', data: { status: 'processing' } })
  }

  if (task.status === 'done') {
    // 不立即删除：若本次响应丢包，前端下次轮询还能拿到结果；由定时清理兜底
    return res.json({ code: 0, msg: 'success', data: { status: 'done', text: task.text } })
  }

  // failed：同样保留到定时清理；用 code 0 + status 返回，让前端能区分"任务失败"与"网络失败"
  res.json({ code: 0, msg: 'failed', data: { status: 'failed', error: task.error || '识别失败' } })
})

// 异步处理：链接来源要先解析+下载，云存储来源先下载，本地来源直接识别
async function processTranscribe(taskId, { link, uploadedPath, cloudVideoId }) {
  running++
  let mediaPath = uploadedPath
  let downloaded = null

  try {
    if (link) {
      const parsed = await parseVideo(link)
      if (parsed.isImage) {
        throw new Error('这是图文作品，没有语音内容可以提取')
      }
      if (!parsed.videoUrl) {
        throw new Error('没能拿到视频地址，请确认链接是否有效')
      }
      downloaded = await downloadVideo(parsed.videoUrl)
      mediaPath = downloaded
    } else if (cloudVideoId) {
      // 云存储上传的视频：先下载到本地
      downloaded = await downloadCloudFile(cloudVideoId)
      mediaPath = downloaded
    }

    const text = await speechToText(mediaPath)
    tasks.set(taskId, { status: 'done', text, error: null })
    console.log(`[Caption] 识别完成: ${taskId}, 共 ${text.length} 字`)
  } catch (err) {
    console.error(`[Caption] 识别失败: ${taskId}, ${err.message}`)
    tasks.set(taskId, { status: 'failed', text: null, error: err.message })
  } finally {
    running--
    // 清理临时文件：服务端下载的视频、以及小程序上传的视频都不再需要
    if (downloaded) fs.unlink(downloaded, () => {})
    if (uploadedPath) fs.unlink(uploadedPath, () => {})
  }

  // 10分钟后自动清理没被取走的任务
  setTimeout(() => tasks.delete(taskId), 10 * 60 * 1000)
}

/**
 * 语音转文字：优先用阿里云 Paraformer(中文准确率高)，
 * 未配置 KEY 或调用失败时自动回退本地 whisper，保证功能不断。
 */
async function speechToText(mediaPath) {
  if (isParaformerEnabled()) {
    try {
      const text = await transcribeByParaformer(mediaPath)
      console.log('[Caption] 使用 Paraformer 云端识别')
      return text
    } catch (err) {
      console.log(`[Caption] Paraformer 失败(${err.message})，回退本地 whisper`)
    }
  }
  return transcribeVideo(mediaPath)
}

/**
 * 将 /uploads/xxx 格式的URL转为本地文件路径。
 * 严格限制在 uploads 目录内，防止路径穿越。（与 routes/image.js 同逻辑）
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
