// server/utils/paraformerClient.js
// 阿里云百炼 Paraformer 语音识别（DashScope 录音文件识别，异步接口）。
// 相比本地 whisper，中文口播准确率更高。按"配了 KEY 就用、否则/失败回退 whisper"接入。
//
// 关键约束：DashScope 录音文件识别是【异步】的，需要一个【公网可访问的音频 URL】——
// 阿里云服务器自己去拉取文件。因此这里先用 ffmpeg 抽出小体积 mp3 放到公开的 uploads 目录，
// 拼出公网 URL 提交，识别完再删除该临时音频。
//
// 环境变量：
//   DASHSCOPE_API_KEY  阿里云百炼 API Key（未配置则本模块视为禁用，调用方回退 whisper）
//   PUBLIC_BASE_URL    本服务的公网基础地址（供阿里云回源拉取音频），默认云托管域名
//   PARAFORMER_MODEL   模型，默认 paraformer-v2
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const axios = require('axios')

const API_KEY = process.env.DASHSCOPE_API_KEY
const MODEL = process.env.PARAFORMER_MODEL || 'paraformer-v2'
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ||
  'https://express-vyz1-286021-10-1457360213.sh.run.tcloudbase.com').replace(/\/$/, '')
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg'
const MAX_SECONDS = Number(process.env.ASR_MAX_SECONDS || 180)
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

const SUBMIT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription'
const TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks'

const FFMPEG_TIMEOUT_MS = 3 * 60 * 1000
const POLL_INTERVAL_MS = 3000
const POLL_MAX_ATTEMPTS = 60 // 最多轮询 ~3 分钟

/** 是否已配置 Paraformer（供调用方决定是否走云端 ASR） */
function isParaformerEnabled() {
  return Boolean(API_KEY)
}

/**
 * 用 Paraformer 识别视频/音频里的语音，返回文字。
 * @param {string} mediaPath 服务器本地文件路径
 * @returns {Promise<string>}
 */
async function transcribeByParaformer(mediaPath) {
  if (!API_KEY) throw new Error('未配置 DASHSCOPE_API_KEY')

  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })
  // 命名匹配 uploadsCleaner 的清理规则（时间戳_随机名），即使异常泄漏也会被 24h 清理兜底
  const audioName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`
  const audioPath = path.join(UPLOADS_DIR, audioName)

  try {
    await extractAudio(mediaPath, audioPath)
    const audioUrl = `${PUBLIC_BASE}/uploads/${audioName}`

    const taskId = await submitTask(audioUrl)
    const transcriptionUrls = await pollTask(taskId)
    const text = await fetchTranscripts(transcriptionUrls)

    if (!text) throw new Error('Paraformer 未返回文本')
    return text
  } finally {
    fs.unlink(audioPath, () => {})
  }
}

/** ffmpeg 抽音轨为 16kHz 单声道 mp3，只取前 MAX_SECONDS 秒（体积小、便于阿里云回源） */
function extractAudio(mediaPath, audioPath) {
  const args = [
    '-y', '-loglevel', 'error',
    '-i', mediaPath,
    '-vn', '-ac', '1', '-ar', '16000',
    '-t', String(MAX_SECONDS),
    '-f', 'mp3', audioPath
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('抽音轨超时')) }, FFMPEG_TIMEOUT_MS)
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`ffmpeg 抽音轨失败: ${stderr.slice(-200)}`))
      const size = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0
      if (size < 1024) return reject(new Error('抽取到的音频为空，可能视频没有声音'))
      resolve()
    })
  })
}

/** 提交异步识别任务，返回 task_id */
async function submitTask(audioUrl) {
  const res = await axios.post(SUBMIT_URL, {
    model: MODEL,
    input: { file_urls: [audioUrl] },
    parameters: { language_hints: ['zh'] }
  }, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable'
    },
    timeout: 30000
  })
  const taskId = res.data && res.data.output && res.data.output.task_id
  if (!taskId) throw new Error('Paraformer 提交任务失败：未返回 task_id')
  return taskId
}

/** 轮询任务直至完成，返回各分片的 transcription_url 列表 */
async function pollTask(taskId) {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS)
    const res = await axios.get(`${TASK_URL}/${taskId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      timeout: 30000
    })
    const output = res.data && res.data.output
    const status = output && output.task_status
    if (status === 'SUCCEEDED') {
      const results = output.results || []
      const urls = results
        .filter(r => r.subtask_status === 'SUCCEEDED' && r.transcription_url)
        .map(r => r.transcription_url)
      if (urls.length === 0) throw new Error('Paraformer 识别完成但无结果文件')
      return urls
    }
    if (status === 'FAILED') {
      throw new Error(`Paraformer 识别失败：${(output && output.message) || '未知错误'}`)
    }
    // PENDING / RUNNING 继续等
  }
  throw new Error('Paraformer 识别超时')
}

/** 拉取并拼接各分片转写结果的纯文本 */
async function fetchTranscripts(urls) {
  const parts = []
  for (const url of urls) {
    const res = await axios.get(url, { timeout: 30000 })
    const transcripts = res.data && res.data.transcripts
    if (Array.isArray(transcripts)) {
      for (const t of transcripts) {
        if (t && t.text) parts.push(String(t.text).trim())
      }
    }
  }
  return parts.join('').trim()
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { transcribeByParaformer, isParaformerEnabled }
