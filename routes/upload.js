// server/routes/upload.js
// 文件上传路由
const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')

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
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.json({ code: -1, msg: '未收到文件', data: null })
  }

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
})

// 上传错误处理
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.json({ code: -1, msg: '文件大小超过20MB限制', data: null })
    }
    return res.json({ code: -1, msg: err.message, data: null })
  }
  if (err) {
    return res.json({ code: -1, msg: err.message, data: null })
  }
  next()
})

module.exports = router
