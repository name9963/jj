// server/app.js - 主入口
const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')

const videoRoutes = require('./routes/video')
const imageRoutes = require('./routes/image')
const uploadRoutes = require('./routes/upload')
const captionRoutes = require('./routes/caption')
const { startUploadsCleaner } = require('./utils/uploadsCleaner')

const app = express()
const PORT = process.env.PORT || 3000

// 中间件
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 静态文件（上传的文件可通过URL访问）
// 先确保目录存在：仓库/镜像里不含 uploads，multer 不会自建目录，缺失时首次上传会报错
const uploadsDir = path.join(__dirname, 'uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir))

// 路由
app.use('/api/video', videoRoutes)
app.use('/api/image', imageRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/caption', captionRoutes)

// 健康检查
app.get('/', (req, res) => {
  res.json({ code: 0, msg: '去水印服务运行中', data: null })
})

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('[Error]', err.message)
  res.status(500).json({ code: -1, msg: '服务器内部错误', data: null })
})

app.listen(PORT, () => {
  console.log(`✓ 去水印服务已启动: http://localhost:${PORT}`)
  // uploads 目录定期清理：上传文件/结果图保留 24 小时，防磁盘堆满
  startUploadsCleaner()
})
