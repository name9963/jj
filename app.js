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
const { securityHeaders, createRateLimiter } = require('./utils/security')

const app = express()
const PORT = process.env.PORT || 3000

// 云托管前面有反向代理，信任第一层代理才能取得真实客户端 IP 用于限流。
app.set('trust proxy', 1)
app.disable('x-powered-by')

// 中间件
app.use(securityHeaders)
app.use(cors({ origin: false, methods: ['GET', 'POST', 'OPTIONS'] }))
app.use(express.json({ limit: '256kb' }))
app.use(express.urlencoded({ extended: true, limit: '256kb' }))

// 公共 API 基础防刷：需兼容最长约 5 分钟的结果轮询，因此额度相对宽松。
app.use('/api', createRateLimiter({ windowMs: 10 * 60 * 1000, max: 360, name: 'api' }))

// 静态文件（上传的文件可通过URL访问）
// 先确保目录存在：仓库/镜像里不含 uploads，multer 不会自建目录，缺失时首次上传会报错
const uploadsDir = path.join(__dirname, 'uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir))

// 高成本任务提交单独收紧；结果轮询不走此额度，避免长任务被误拦截。
const heavyLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 20, name: 'heavy' })

// 路由
app.use('/api/video', videoRoutes)
app.use('/api/image/remove-watermark', heavyLimiter)
app.use('/api/upload', heavyLimiter)
app.use('/api/caption/extract', heavyLimiter)
app.use('/api/image', imageRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/caption', captionRoutes)

// 健康检查
app.get('/', (req, res) => {
  res.json({ code: 0, msg: '去水印服务运行中', data: null })
})

// 404 与全局错误处理
app.use((req, res) => {
  res.status(404).json({ code: -1, msg: '接口不存在', data: null })
})

app.use((err, req, res, next) => {
  console.error('[Error]', err.message)
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ code: -1, msg: '请求内容过大', data: null })
  }
  const status = Number(err.statusCode)
  if (status >= 400 && status < 500) {
    return res.status(status).json({ code: -1, msg: err.message || '请求参数无效', data: null })
  }
  res.status(500).json({ code: -1, msg: '服务器内部错误', data: null })
})

app.listen(PORT, () => {
  console.log(`✓ 去水印服务已启动: http://localhost:${PORT}`)
  // uploads 目录定期清理：上传文件/结果图保留 24 小时，防磁盘堆满
  startUploadsCleaner()
})
