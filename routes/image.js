// server/routes/image.js
// 图片去水印路由：异步处理，避免网关超时
const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const { removeWatermark } = require('../utils/imageInpaint')
const { inpaintByLama } = require('../utils/lamaClient')

// uploads 目录绝对路径，用于路径穿越校验
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

// 任务存储（内存中，单实例足够）
const tasks = new Map()

// POST /api/image/remove-watermark
// 立即返回 taskId，后台异步处理
router.post('/remove-watermark', (req, res) => {
  const { imageUrl, maskUrl } = req.body

  if (!imageUrl || !maskUrl) {
    return res.json({ code: -1, msg: '缺少图片或遮罩参数', data: null })
  }

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

  // 创建任务
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  tasks.set(taskId, { status: 'processing', resultUrl: null, error: null })

  console.log(`[Image] 去水印任务创建: ${taskId}, 图片: ${imageUrl}`)

  // 立即返回 taskId
  res.json({ code: 0, msg: 'success', data: { taskId } })

  // 后台异步处理
  processInpaint(taskId, imagePath, maskPath)
})

// GET /api/image/result/:taskId
// 轮询任务结果
router.get('/result/:taskId', (req, res) => {
  const { taskId } = req.params
  const task = tasks.get(taskId)

  if (!task) {
    return res.json({ code: -1, msg: '任务不存在', data: null })
  }

  if (task.status === 'processing') {
    return res.json({ code: 0, msg: 'processing', data: { status: 'processing' } })
  }

  if (task.status === 'done') {
    // 不立即删除：若本次响应丢包，前端下次轮询还能拿到结果；由定时清理兜底
    return res.json({ code: 0, msg: 'success', data: { status: 'done', resultUrl: task.resultUrl } })
  }

  // failed：同样保留到定时清理；用 code 0 + status 返回，让前端能区分"任务失败"与"网络失败"
  res.json({ code: 0, msg: 'failed', data: { status: 'failed', error: task.error || '处理失败' } })
})

// 异步处理函数
async function processInpaint(taskId, imagePath, maskPath) {
  try {
    let resultPath
    try {
      resultPath = await inpaintByLama(imagePath, maskPath)
      console.log(`[Image] LaMa AI去水印成功: ${taskId}`)
    } catch (aiErr) {
      console.log(`[Image] LaMa失败(${aiErr.message})，回退本地算法: ${taskId}`)
      resultPath = await removeWatermark(imagePath, maskPath)
    }

    const fileName = path.basename(resultPath)
    const resultUrl = `/uploads/${fileName}`

    tasks.set(taskId, { status: 'done', resultUrl, error: null })
    console.log(`[Image] 去水印完成: ${taskId} → ${resultUrl}`)
  } catch (err) {
    console.error(`[Image] 处理失败: ${taskId}, ${err.message}`)
    tasks.set(taskId, { status: 'failed', resultUrl: null, error: err.message })
  }

  // 5分钟后自动清理未完成的任务
  setTimeout(() => tasks.delete(taskId), 5 * 60 * 1000)
}

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
