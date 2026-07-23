// server/app.js - 主入口
const express = require('express')
const cors = require('cors')
const path = require('path')

const videoRoutes = require('./routes/video')
const imageRoutes = require('./routes/image')
const uploadRoutes = require('./routes/upload')

const app = express()
const PORT = process.env.PORT || 3000

// 中间件
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 静态文件（上传的文件可通过URL访问）
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// 路由
app.use('/api/video', videoRoutes)
app.use('/api/image', imageRoutes)
app.use('/api/upload', uploadRoutes)

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
})
