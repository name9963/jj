// server/routes/upload.js
// 文件上传路由
const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const sharp = require('sharp')

// 配置 multer 存储
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'))
  },
  filename: (req, file, cb) => {
    // 生成唯一文件名
    const ext = path.extname(file.originalname) || '.png'
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`
    cb(null, name)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 最大 20MB
  fileFilter: (req, file, cb) => {
    // mov/m4v：iPhone 相册视频常见格式（文案提取语音识别可直接读取）
    // wx.uploadFile 传来的 originalname 不一定带扩展名，扩展名与 mimetype 任一命中即放行
    const allowedExt = /\.(jpg|jpeg|png|gif|webp|mp4|mov|m4v)$/i
    const allowedMime = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|quicktime|x-m4v))$/i
    if (allowedExt.test(path.extname(file.originalname)) || allowedMime.test(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('不支持的文件格式'))
    }
  }
})

// POST /api/upload
router.post('/', upload.single('file'), async (req, res, next) => {
  if (!req.file) {
    return res.json({ code: -1, msg: '未收到文件', data: null })
  }

  try {
    await validateUploadedFile(req.file)

    const fileUrl = `/uploads/${req.file.filename}`
    console.log(`[Upload] 文件上传成功: ${fileUrl}`)

    res.json({
      code: 0,
      msg: 'success',
      data: {
        url: fileUrl,
        filename: req.file.filename,
        size: req.file.size
      }
    })
  } catch (err) {
    fs.unlink(req.file.path, () => {})
    next(err)
  }
})

/**
 * POST /api/upload/base64
 * 供 wx.cloud.callContainer 使用（callContainer 无法做 multipart 上传）。
 * body: { data: <base64>, ext }。大请求体由本路由自带的 30mb JSON 解析器处理（全局 256kb 已跳过此路径）。
 */
router.post('/base64', express.json({ limit: '30mb' }), async (req, res, next) => {
  const { data, ext } = req.body || {}
  if (!data || typeof data !== 'string') {
    return res.json({ code: -1, msg: '未收到文件数据', data: null })
  }

  const buf = Buffer.from(data, 'base64')
  if (!buf.length || buf.length > 20 * 1024 * 1024) {
    return res.json({ code: -1, msg: '文件为空或超过 20MB', data: null })
  }

  const safeExt = /^[a-zA-Z0-9]{1,5}$/.test(ext || '') ? String(ext).toLowerCase() : 'png'
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${safeExt}`
  const uploadsDir = path.join(__dirname, '..', 'uploads')
  const filePath = path.join(uploadsDir, filename)

  try {
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(filePath, buf)
    // 复用真实文件内容校验（originalname 带真实扩展名，供其判断图片/视频）
    await validateUploadedFile({ path: filePath, mimetype: '', originalname: filename })

    console.log(`[Upload] base64 上传成功: /uploads/${filename}`)
    res.json({ code: 0, msg: 'success', data: { url: `/uploads/${filename}`, filename, size: buf.length } })
  } catch (err) {
    fs.unlink(filePath, () => {})
    next(err)
  }
})

/**
 * 校验真实文件内容，而不是只相信客户端给出的扩展名/MIME。
 * 图片由 sharp 解码并限制总像素；视频检查常见容器文件头，详细可播放性再由 ffmpeg 校验。
 */
async function validateUploadedFile(file) {
  const header = Buffer.alloc(32)
  const fd = fs.openSync(file.path, 'r')
  try {
    fs.readSync(fd, header, 0, header.length, 0)
  } finally {
    fs.closeSync(fd)
  }

  const isImage = /^image\//i.test(file.mimetype) || /\.(jpg|jpeg|png|gif|webp)$/i.test(file.originalname)
  if (isImage) {
    let meta
    try {
      meta = await sharp(file.path, { limitInputPixels: 40_000_000 }).metadata()
    } catch {
      const err = new Error('图片内容无效或像素尺寸过大')
      err.statusCode = 400
      throw err
    }
    if (!meta.width || !meta.height || meta.width * meta.height > 40_000_000) {
      const err = new Error('图片像素过大，最大支持4000万像素')
      err.statusCode = 400
      throw err
    }
    return
  }

  // MP4/MOV/M4V 容器通常在前 32 字节包含 ftyp 标记。
  if (header.toString('ascii', 4, 8) !== 'ftyp') {
    const err = new Error('视频文件内容无效，仅支持 MP4、MOV、M4V')
    err.statusCode = 400
    throw err
  }
}

// 上传错误处理
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.json({ code: -1, msg: '文件大小超过20MB限制', data: null })
    }
    return res.json({ code: -1, msg: err.message, data: null })
  }
  if (err) {
    const status = err.statusCode || 400
    return res.status(status).json({ code: -1, msg: err.message, data: null })
  }
  next()
})

module.exports = router
