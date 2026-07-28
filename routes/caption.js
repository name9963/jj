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
const { extractSubtitleText } = require('../utils/subtitleOcr')
const { downloadVideo } = require('../utils/mediaFetch')
const { parseVideo } = require('../utils/videoParser')
const { setTask, getTask } = require('../utils/taskStore')

// uploads 目录绝对路径，用于路径穿越校验
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

// 任务状态写入 CloudBase 数据库，所有云托管实例和版本共享。
// 不能使用进程内 Map：提交和轮询可能被网关分发到不同实例，实例重启也会清空内存。

// 语音识别很吃 CPU，限制并发，超出直接让用户稍后再试
let running = 0
const MAX_RUNNING = Number(process.env.ASR_MAX_CONCURRENCY || 1)

// POST /api/caption/extract
// body: { link } 或 { videoUrl }
router.post('/extract', async (req, res) => {
  const { link, videoUrl, recognizeMode } = req.body || {}

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

  // 识别方式：auto(默认) | subtitle 字幕OCR | speech 语音识别
  const mode = ['auto', 'subtitle', 'speech'].includes(recognizeMode) ? recognizeMode : 'auto'

  // 本地上传的视频：先校验文件确实存在
  let uploadedPath = null
  if (!link) {
    uploadedPath = urlToLocalPath(videoUrl)
    if (!uploadedPath) {
      return res.json({ code: -1, msg: '非法的文件路径', data: null })
    }
    if (!fs.existsSync(uploadedPath)) {
      return res.json({ code: -1, msg: '视频文件不存在，请重新上传', data: null })
    }
  }

  const taskId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  try {
    await setTask(taskId, { type: 'caption', status: 'processing', text: null, error: null })
  } catch (err) {
    console.error(`[Caption] 创建持久化任务失败: ${err.message}`)
    return res.status(503).json({ code: -1, msg: '任务服务暂时不可用，请稍后重试', data: null })
  }

  console.log(`[Caption] 口播识别任务创建: ${taskId}, 来源: ${link ? '链接 ' + link.slice(0, 60) : videoUrl}`)

  // 立即返回 taskId
  res.json({ code: 0, msg: 'success', data: { taskId, maxSeconds: MAX_SECONDS } })

  // 后台异步处理
  processTranscribe(taskId, { link, uploadedPath, mode })
})

// GET /api/caption/result/:taskId
// 轮询任务结果
router.get('/result/:taskId', async (req, res) => {
  const { taskId } = req.params
  let task
  try {
    task = await getTask(taskId)
  } catch (err) {
    console.error(`[Caption] 读取持久化任务失败: ${err.message}`)
    return res.status(503).json({ code: -1, msg: '任务服务暂时不可用，请稍后重试', data: null })
  }

  if (!task) {
    return res.json({ code: -1, msg: '任务记录不存在，请重新提交识别', data: null })
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

// 异步处理：链接来源要先解析+下载，本地来源直接识别
async function processTranscribe(taskId, { link, uploadedPath, mode }) {
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
    }

    const text = await extractText(mediaPath, mode)
    await setTask(taskId, { type: 'caption', status: 'done', text, error: null })
    console.log(`[Caption] 识别完成: ${taskId}, 共 ${text.length} 字`)
  } catch (err) {
    console.error(`[Caption] 识别失败: ${taskId}, ${err.message}`)
    try {
      await setTask(taskId, { type: 'caption', status: 'failed', text: null, error: err.message })
    } catch (storeErr) {
      console.error(`[Caption] 保存失败状态异常: ${storeErr.message}`)
    }
  } finally {
    running--
    // 清理临时文件：服务端下载的视频、以及小程序上传的视频都不再需要
    if (downloaded) fs.unlink(downloaded, () => {})
    if (uploadedPath) fs.unlink(uploadedPath, () => {})
  }
}

/**
 * 根据用户选择的识别方式提取文案：
 *  - speech：只用语音识别
 *  - subtitle：只用字幕 OCR；未识别到字幕则报错提示换语音模式(不静默回退，尊重用户选择)
 *  - auto(默认)：先试字幕 OCR，检测到稳定字幕就用，否则回退语音识别
 */
async function extractText(mediaPath, mode) {
  if (mode === 'speech') {
    return transcribeVideo(mediaPath)
  }

  if (mode === 'subtitle') {
    const ocr = await extractSubtitleText(mediaPath)
    if (ocr && ocr.ok && ocr.text) {
      console.log(`[Caption] 字幕OCR结果(${ocr.lines}句)`)
      return ocr.text
    }
    throw new Error('未在画面中识别到字幕，请改用“语音识别”或“自动”模式重试')
  }

  // auto：字幕优先，无字幕回退语音
  try {
    const ocr = await extractSubtitleText(mediaPath)
    if (ocr && ocr.ok && ocr.text) {
      console.log(`[Caption] 自动模式→使用字幕OCR结果(${ocr.lines}句)`)
      return ocr.text
    }
    console.log('[Caption] 自动模式→未检测到稳定字幕，回退语音识别')
  } catch (err) {
    console.log(`[Caption] 自动模式→字幕OCR异常(${err.message})，回退语音识别`)
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
