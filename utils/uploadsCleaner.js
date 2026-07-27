// server/utils/uploadsCleaner.js
// uploads 目录定期清理：上传的原图/遮罩/视频与生成的结果图都是一次性文件，
// 处理完成后不再需要，长期堆积会撑满磁盘。
// 只清理运行时命名模式的文件（时间戳_随机名 / result_时间戳），
// 不会误删 test_*.png 等手工放置的文件。
const fs = require('fs')
const path = require('path')

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 文件保留 24 小时
const INTERVAL_MS = 60 * 60 * 1000     // 每小时清理一次

// multer 上传: 1784786392361_ezxn2i.png；处理结果: result_1784861515485.png
const RUNTIME_FILE = /^(\d{13}_[a-z0-9]+|result_\d{13})\.\w+$/i

function cleanOnce() {
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) return // 目录不存在等情况直接跳过，首次上传时 multer 会建目录
    const now = Date.now()
    files.forEach((name) => {
      if (!RUNTIME_FILE.test(name)) return
      const filePath = path.join(UPLOADS_DIR, name)
      fs.stat(filePath, (statErr, stat) => {
        if (statErr) return
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlink(filePath, (delErr) => {
            if (!delErr) console.log(`[Cleaner] 已清理过期文件: ${name}`)
          })
        }
      })
    })
  })
}

/** 启动定期清理：启动时清一次，之后每小时一次。timer.unref 不阻碍进程退出 */
function startUploadsCleaner() {
  cleanOnce()
  const timer = setInterval(cleanOnce, INTERVAL_MS)
  if (timer.unref) timer.unref()
}

module.exports = { startUploadsCleaner }
