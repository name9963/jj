// server/utils/mediaFetch.js
// 把平台视频下载到服务器本地临时文件，供语音识别使用。
// 小程序端只传分享链接，视频由服务端自己取——因为抖音等 CDN 需要特定请求头，
// 而且 CDN 链接有效期只有几分钟，解析完必须马上下载。
const axios = require('axios')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pipeline } = require('stream/promises')
const { Transform } = require('stream')

// 单个视频最大下载体积，超过直接中断（口播识别只用前几分钟，不需要完整大文件）
const MAX_BYTES = Number(process.env.ASR_MAX_DOWNLOAD_MB || 200) * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

/**
 * 按视频地址所属平台给出合适的请求头（部分 CDN 校验 Referer 防盗链）
 */
function headersFor(url) {
  const headers = { 'User-Agent': MOBILE_UA }
  if (/bilivideo\.com|bilibili/.test(url)) {
    headers.Referer = 'https://www.bilibili.com/'
  } else if (/kuaishou|gifshow|kwaicdn|kwimgs|yximgs/.test(url)) {
    headers.Referer = 'https://www.kuaishou.com/'
  } else if (/xhscdn|xiaohongshu/.test(url)) {
    headers.Referer = 'https://www.xiaohongshu.com/'
  } else if (/weibocdn|sinaimg|weibo/.test(url)) {
    headers.Referer = 'https://weibo.com/'
  } else if (/douyin|iesdouyin|bytecdn|zjcdn/.test(url)) {
    headers.Referer = 'https://www.douyin.com/'
  }
  return headers
}

/**
 * 下载视频到系统临时目录。
 * @param {string} videoUrl - 绝对地址；若是本服务的相对路径(如B站代理 /api/video/proxy?url=)，
 *                            会自动拼上本机地址，复用服务端已有的带 Referer 转发逻辑。
 * @returns {Promise<string>} 本地文件路径（调用方负责删除）
 */
async function downloadVideo(videoUrl, signal) {
  let url = videoUrl
  if (!/^https?:\/\//i.test(url)) {
    const parsed = new URL(url, 'http://local')
    if (parsed.pathname !== '/api/video/proxy') throw new Error('非法的视频地址')
    url = parsed.searchParams.get('url')
  }
  const { isAllowedProxyTarget } = require('./videoParser')
  if (!isAllowedProxyTarget(url)) throw new Error('视频下载地址不受支持')

  const destPath = path.join(
    require('./runtimePaths').workDir,
    `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`
  )

  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal) {
    if (signal.aborted) signal.throwIfAborted()
    signal.addEventListener('abort', abort, { once: true })
  }
  const timer = setTimeout(abort, DOWNLOAD_TIMEOUT_MS)
  timer.unref()
  let bytes = 0
  try {
    const response = await axios.get(url, {
      signal: controller.signal,
      responseType: 'stream',
      headers: headersFor(url),
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 5,
      beforeRedirect: options => {
        if (!isAllowedProxyTarget(`${options.protocol}//${options.hostname}${options.port ? ':' + options.port : ''}${options.path || '/'}`)) {
          throw new Error('视频重定向到了非白名单地址')
        }
      }
    })
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length
        callback(bytes > MAX_BYTES ? new Error('视频体积过大，请换个短一点的视频') : null, chunk)
      }
    })
    await pipeline(response.data, limit, fs.createWriteStream(destPath), { signal: controller.signal })
    if (bytes < 1024) throw new Error('下载到的内容异常，链接可能已失效')
    return destPath
  } catch (err) {
    // pipeline 已关闭文件句柄，Windows 上也能可靠清理失败下载。
    await fs.promises.unlink(destPath).catch(failure => {
      if (failure.code !== 'ENOENT') console.error('[MediaFetch] 清理失败:', failure.code)
    })
    throw new Error(controller.signal.aborted ? '视频下载超时或已取消' : `视频下载失败：${err.message}`)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', abort)
  }
}

module.exports = { downloadVideo, headersFor }
