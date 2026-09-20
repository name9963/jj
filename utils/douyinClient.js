// server/utils/douyinClient.js
// 抖音解析客户端：调用同镜像内的 Python 脚本完成解析。
//
// 为什么用 Python 子进程而不是纯 Node：
//   抖音要求 (1) 浏览器 TLS/HTTP2 指纹，(2) a_bogus 签名，(3) x-secsdk-web-signature，
//   三者在 Node 生态里缺乏可靠实现。`douyin/` 目录内的脚本用 curl_cffi 冒充 Chrome
//   完成 TLS 指纹，并用纯算法生成两种签名，是目前可维护的方案。
//
// 环境变量：
//   DOUYIN_PYTHON     Python 解释器路径，默认 python3（镜像内）
//   DOUYIN_TIMEOUT    单次解析超时毫秒数，默认 60000
const { execFile } = require('child_process')
const path = require('path')

const PYTHON = process.env.DOUYIN_PYTHON || 'python3'
const SCRIPT = path.join(__dirname, '..', 'douyin', 'fetch_video.py')
const TIMEOUT_MS = Number(process.env.DOUYIN_TIMEOUT || 60000)

/**
 * 解析抖音分享链接，返回无水印视频/图文信息。
 * @param {string} shareUrl 分享链接（含短链）或纯 aweme_id
 * @returns {Promise<{videoUrl:string, cover:string, title:string, awemeId:string, isImage?:boolean, imageUrls?:string[]}>}
 */
function parseDouyin(shareUrl) {
  return new Promise((resolve, reject) => {
    if (!shareUrl || typeof shareUrl !== 'string') {
      reject(new Error('缺少抖音链接'))
      return
    }

    execFile(
      PYTHON,
      [SCRIPT, shareUrl],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        cwd: path.join(__dirname, '..', 'douyin')
      },
      (err, stdout, stderr) => {
        // 脚本把结果以单行 JSON 写到 stdout；即使返回非 0 退出码也可能有有效 JSON
        const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || ''

        let payload = null
        if (line) {
          try { payload = JSON.parse(line) } catch (e) { payload = null }
        }

        if (payload && payload.ok) {
          resolve({
            videoUrl: payload.videoUrl,
            cover: payload.cover || '',
            title: payload.title || '抖音视频',
            awemeId: payload.awemeId || '',
            isImage: Boolean(payload.isImage),
            imageUrls: payload.imageUrls || undefined
          })
          return
        }

        // 失败路径：把脚本给出的原因透出来，便于日志定位
        if (payload && payload.error) {
          const detail = payload.bodyHead ? `（响应片段：${String(payload.bodyHead).slice(0, 120)}）` : ''
          reject(new Error(`${payload.error}${detail}`))
          return
        }

        if (err && err.killed) {
          reject(new Error('抖音解析超时，请稍后重试'))
          return
        }

        const errText = String(stderr || '').trim().slice(-300)
        if (/ModuleNotFoundError|No module named/.test(errText)) {
          reject(new Error('抖音解析组件依赖缺失（镜像未安装 Python 依赖）'))
          return
        }
        if (/ENOENT/.test(errText) || (err && err.code === 'ENOENT')) {
          reject(new Error('抖音解析组件不可用（未找到 Python 解释器）'))
          return
        }
        reject(new Error(`抖音解析失败${errText ? `：${errText}` : ''}`))
      }
    )
  })
}

module.exports = { parseDouyin }
