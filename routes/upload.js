// server/routes/upload.js
// 文件上传路由
const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const sharp = require('sharp')
const crypto = require('crypto')
const resources = require('../utils/resources')
const secCheck = require('../utils/secCheck')

// 配置 multer 存储
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, require('../utils/runtimePaths').uploadsDir)
  },
  filename: (req, file, cb) => {
    // 生成唯一文件名
    const ext = /\.(jpg|jpeg|png|gif|webp|mp4|mov|m4v)$/i.test(file.originalname) ? path.extname(file.originalname).toLowerCase() : '.bin'
    const name = `upload_${crypto.randomUUID()}${ext}`
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
    const kind = await validateUploadedFile(req.file)

    // ---- 内容安全检测（UGC 合规要求，微信审核强制项）----
    // 检测不通过时只提示「内容含违规信息」，不暴露具体违规类型（审核明确要求）。
    try {
      const check = await secCheck.checkUpload(req.file.path, req.file.mimetype)
      if (check && check.safe === false) {
        fs.unlink(req.file.path, () => {})
        return res.json({ code: -1, msg: '上传内容含违规信息', data: null })
      }
    } catch (checkErr) {
      // 检测服务异常（未配置密钥/微信接口抖动）时保守放行，仅记录告警，
      // 避免因检测链路故障导致全部上传不可用；正式环境须确保密钥已配置。
      console.warn('[SecCheck] 内容安全检测未能执行：', checkErr.message)
    }

    const resource = resources.register(req.file.path, req.owner, kind)

    res.json({
      code: 0,
      msg: 'success',
      data: {
        url: resource.id,
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
    return 'image'
  }

  // MP4/MOV/M4V 容器通常在前 32 字节包含 ftyp 标记。
  if (header.toString('ascii', 4, 8) !== 'ftyp') {
    const err = new Error('视频文件内容无效，仅支持 MP4、MOV、M4V')
    err.statusCode = 400
    throw err
  }
  return 'video'
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
