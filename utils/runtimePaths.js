// 单实例部署可将 APP_DATA_DIR 指向持久卷，包含文件、任务状态和签名密钥。
const fs = require('fs')
const path = require('path')
const dataDir = process.env.APP_DATA_DIR && path.resolve(process.env.APP_DATA_DIR)
const stateDir = path.resolve(process.env.PRIVATE_STATE_DIR || (dataDir ? path.join(dataDir, 'state') : path.join(__dirname, '..', '.runtime')))
const uploadsDir = dataDir ? path.join(dataDir, 'uploads') : path.join(__dirname, '..', 'uploads')
const workDir = dataDir ? path.join(dataDir, 'work') : path.join(stateDir, 'work')
for (const dir of [stateDir, uploadsDir, workDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
module.exports = { stateDir, uploadsDir, workDir }
