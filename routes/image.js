// server/routes/image.js
// 图片去水印路由：异步处理，避免网关超时
const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs')
const { removeWatermarkInWorker } = require('../utils/imageInpaintWorker')
const { inpaintByLama } = require('../utils/lamaClient')
const { isCloudFileID, downloadCloudFile, uploadCloudFile } = require('../utils/cloudStorage')

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
  if (typeof imageUrl !== 'string' || typeof maskUrl !== 'string' ||
      imageUrl.length > 600 || maskUrl.length > 600) {
    return res.json({ code: -1, msg: '图片地址参数无效', data: null })
  }

  // 两种来源：云存储 fileID(cloud://，B+ 方案) 或本地 /uploads 路径(兼容旧方案)
  const imageIsCloud = isCloudFileID(imageUrl)
  const maskIsCloud = isCloudFileID(maskUrl)
  let imagePath = null
  let maskPath = null
  if (!imageIsCloud) {
    imagePath = urlToLocalPath(imageUrl)
    if (!imagePath) return res.json({ code: -1, msg: '非法的图片路径', data: null })
    if (!fs.existsSync(imagePath)) return res.json({ code: -1, msg: '原图文件不存在', data: null })
  }
  if (!maskIsCloud) {
    maskPath = urlToLocalPath(maskUrl)
    if (!maskPath) return res.json({ code: -1, msg: '非法的文件路径', data: null })
    if (!fs.existsSync(maskPath)) return res.json({ code: -1, msg: '遮罩文件不存在', data: null })
  }

  // 创建任务
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  tasks.set(taskId, { status: 'processing', resultUrl: null, error: null })

  console.log(`[Image] 去水印任务创建: ${taskId}`)

  // 立即返回 taskId
  res.json({ code: 0, msg: 'success', data: { taskId } })

  // 后台异步处理
  processInpaint(taskId, { imageUrl, maskUrl, imagePath, maskPath })
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
async function processInpaint(taskId, { imageUrl, maskUrl, imagePath, maskPath }) {
  const tempFiles = []
  try {
    // 云存储来源：先下载到本地再处理
    if (isCloudFileID(imageUrl)) {
      imagePath = await downloadCloudFile(imageUrl)
      tempFiles.push(imagePath)
    }
    if (isCloudFileID(maskUrl)) {
      maskPath = await downloadCloudFile(maskUrl)
      tempFiles.push(maskPath)
    }

    let resultPath
    try {
      resultPath = await inpaintByLama(imagePath, maskPath)
      console.log(`[Image] LaMa AI去水印成功: ${taskId}`)
    } catch (aiErr) {
      console.log(`[Image] LaMa失败(${aiErr.message})，回退本地算法: ${taskId}`)
      resultPath = await removeWatermarkInWorker(imagePath, maskPath)
    }

    // 结果回传：若请求来自云存储，则把结果也传回云存储，返回 fileID；
    // 否则(旧方案)返回 /uploads 相对路径。
    let resultUrl
    if (isCloudFileID(imageUrl)) {
      const fileName = path.basename(resultPath)
      resultUrl = await uploadCloudFile(resultPath, `results/${fileName}`)
      // 上传后本地结果文件不再需要
      fs.unlink(resultPath, () => {})
    } else {
      resultUrl = `/uploads/${path.basename(resultPath)}`
    }

    tasks.set(taskId, { status: 'done', resultUrl, error: null })
    console.log(`[Image] 去水印完成: ${taskId} → ${resultUrl.slice(0, 40)}`)
  } catch (err) {
    console.error(`[Image] 处理失败: ${taskId}, ${err.message}`)
    tasks.set(taskId, { status: 'failed', resultUrl: null, error: err.message })
  } finally {
    // 清理云存储下载的临时文件
    tempFiles.forEach((f) => fs.unlink(f, () => {}))
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
