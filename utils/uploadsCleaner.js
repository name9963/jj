// server/utils/uploadsCleaner.js
// uploads 目录定期清理：上传的原图/遮罩/视频与生成的结果图都是一次性文件，
// 处理完成后不再需要，长期堆积会撑满磁盘。
// 只清理运行时命名模式的文件（时间戳_随机名 / result_时间戳），
// 不会误删 test_*.png 等手工放置的文件。
const fs = require('fs')
const path = require('path')

const { uploadsDir: UPLOADS_DIR, workDir } = require('./runtimePaths')
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 文件保留 24 小时
const INTERVAL_MS = 60 * 1000         // 每分钟检查；到期访问由资源接口立即拒绝

// multer 上传: 1784786392361_ezxn2i.png；处理结果: result_1784861515485.png
const RUNTIME_FILE = /^(\d{13}_[a-z0-9]+|result_\d{13}|(?:upload|result|audio)_[a-f0-9-]{36})\.\w+$/i

function cleanOnce() {
  try {
    require('./resources').cleanExpired()
    require('./tasks').cleanExpired()
  } catch (err) { console.error('[Cleaner] 状态清理失败，将重试:', err.code || err.name) }
  let protectedFiles
  try { protectedFiles = require('./resources').protectedPaths() } catch (err) { return }
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) return // 目录不存在等情况直接跳过，首次上传时 multer 会建目录
    const now = Date.now()
    files.forEach((name) => {
      if (!RUNTIME_FILE.test(name)) return
      const filePath = path.join(UPLOADS_DIR, name)
      if (protectedFiles.has(filePath)) return
      fs.stat(filePath, (statErr, stat) => {
        if (statErr) return
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlink(filePath, (delErr) => {
            if (!delErr) console.log(`[Cleaner] 已清理过期文件: ${name}`)
            else if (delErr.code !== 'ENOENT') console.error('[Cleaner] 文件删除失败，将重试:', delErr.code)
          })
        }
      })
    })
  })
  // 工作副本均由服务创建；最长任务20分钟，24小时阈值用于清理崩溃残留。
  fs.readdir(workDir, (err, files) => {
    if (err) return
    for (const name of files) {
      if (!/^(caption_[a-f0-9-]{36}|(?:src|asr)_\d{13}_[a-z0-9]+)\.(mp4|wav|txt)$/.test(name)) continue
      const file = path.join(workDir, name)
      fs.stat(file, (error, stat) => {
        if (!error && Date.now() - stat.mtimeMs > MAX_AGE_MS) fs.unlink(file, failure => {
          if (failure && failure.code !== 'ENOENT') console.error('[Cleaner] 临时文件删除失败:', failure.code)
        })
      })
    }
  })
}

/** 启动时及每分钟清理一次；失败保留至下一次重试。 */
function startUploadsCleaner() {
  cleanOnce()
  const timer = setInterval(cleanOnce, INTERVAL_MS)
  if (timer.unref) timer.unref()
}

module.exports = { startUploadsCleaner, cleanOnce }
