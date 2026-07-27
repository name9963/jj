// server/utils/mediaFetch.js
// 把平台视频下载到服务器本地临时文件，供语音识别使用。
// 小程序端只传分享链接，视频由服务端自己取——因为抖音等 CDN 需要特定请求头，
// 而且 CDN 链接有效期只有几分钟，解析完必须马上下载。
const axios = require('axios')
const fs = require('fs')
const os = require('os')
const path = require('path')

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
  } else if (/kuaishou|gifshow/.test(url)) {
    headers.Referer = 'https://www.kuaishou.com/'
  } else if (/xhscdn|xiaohongshu/.test(url)) {
    headers.Referer = 'https://www.xiaohongshu.com/'
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
async function downloadVideo(videoUrl) {
  let url = videoUrl
  if (!/^https?:\/\//i.test(url)) {
    const port = process.env.PORT || 3000
    url = `http://127.0.0.1:${port}${url.startsWith('/') ? '' : '/'}${url}`
  }

  const destPath = path.join(
    os.tmpdir(),
    `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`
  )

  let response
  try {
    response = await axios.get(url, {
      responseType: 'stream',
      headers: headersFor(videoUrl),
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 5
    })
  } catch (err) {
    throw new Error(`视频下载失败（链接可能已过期，请重新提交）：${err.message}`)
  }

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath)
    let bytes = 0
    let aborted = false

    const fail = (err) => {
      if (aborted) return
      aborted = true
      response.data.destroy()
      writer.destroy()
      fs.unlink(destPath, () => {})
      reject(err)
    }

    response.data.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BYTES) {
        fail(new Error('视频体积过大，暂不支持识别，请换个短一点的视频'))
      }
    })

    response.data.on('error', () => fail(new Error('视频下载中断，链接可能已过期，请重新提交')))
    writer.on('error', () => fail(new Error('视频写入失败，请稍后重试')))

    writer.on('finish', () => {
      if (aborted) return
      if (bytes < 1024) {
        fs.unlink(destPath, () => {})
        reject(new Error('下载到的内容异常（文件过小），链接可能已失效'))
        return
      }
      console.log(`[MediaFetch] 视频下载完成: ${(bytes / 1024 / 1024).toFixed(1)}MB`)
      resolve(destPath)
    })

    response.data.pipe(writer)
  })
}

module.exports = { downloadVideo }
