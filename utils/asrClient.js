// server/utils/asrClient.js
// 语音转文字（把视频里说的话转成文字）：ffmpeg 抽音轨 → whisper.cpp 离线识别
//
// 选它的原因：完全离线免费、不需要任何第三方账号密钥；whisper.cpp 是纯 C++ 实现，
// 编译成单个静态二进制内置在镜像里（见 Dockerfile 第一阶段）。
//
// 可选环境变量：
//   WHISPER_BIN     whisper-cli 路径（镜像内默认 /usr/local/bin/whisper-cli）
//   WHISPER_MODEL   模型路径（镜像内默认 /app/models/ggml-model.bin）
//   FFMPEG_BIN      ffmpeg 路径，默认从 PATH 找
//   ASR_MAX_SECONDS 最多识别前多少秒音频，默认 180（识别耗时与音频长度成正比，防止长视频卡死）
//   ASR_THREADS     识别线程数，默认按 CPU 核数取，最多 4
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli'
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/app/models/ggml-model.bin'
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg'
const MAX_SECONDS = Number(process.env.ASR_MAX_SECONDS || 180)
const THREADS = String(
  Number(process.env.ASR_THREADS) || Math.max(1, Math.min(4, os.cpus().length))
)
const BEAM_SIZE = String(Number(process.env.ASR_BEAM_SIZE || 5))
const AUDIO_FILTER = process.env.ASR_AUDIO_FILTER ||
  'highpass=f=80,lowpass=f=7600,afftdn=nf=-25,loudnorm=I=-16:LRA=11:TP=-1.5'

const FFMPEG_TIMEOUT_MS = 3 * 60 * 1000
const WHISPER_TIMEOUT_MS = 12 * 60 * 1000

/**
 * 识别视频/音频里的语音，返回文字。
 * @param {string} mediaPath - 服务器本地文件路径（mp4/mov/m4a/mp3 等 ffmpeg 能读的格式）
 * @returns {Promise<string>}
 */
async function transcribeVideo(mediaPath) {
  const wavPath = path.join(
    os.tmpdir(),
    `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`
  )

  // whisper 用 -otxt 把结果写到 <前缀>.txt，前缀取 wav 的同名路径
  const outPrefix = wavPath.replace(/\.wav$/, '')
  const txtPath = `${outPrefix}.txt`

  try {
    await extractAudio(mediaPath, wavPath)
    const text = await runWhisper(wavPath, outPrefix, txtPath)
    if (!text) {
      throw new Error('没有识别到人说话的内容，这个视频可能只有音乐或没有声音')
    }
    return text
  } finally {
    fs.unlink(wavPath, () => {})
    fs.unlink(txtPath, () => {})
  }
}

/**
 * 抽音轨：转成 whisper 要求的 16kHz 单声道 PCM WAV，并只取前 MAX_SECONDS 秒。
 */
function extractAudio(mediaPath, wavPath) {
  const args = [
    '-y',
    '-loglevel', 'error',
    '-i', mediaPath,
    '-vn',                       // 丢掉画面，只要声音
    '-ac', '1',                  // 单声道
    '-ar', '16000',              // 16kHz
    '-af', AUDIO_FILTER,         // 过滤低频/高频噪声、轻量降噪并统一口播响度
    '-t', String(MAX_SECONDS),   // 最多取前 N 秒
    '-f', 'wav',
    wavPath
  ]

  return run(FFMPEG_BIN, args, FFMPEG_TIMEOUT_MS)
    .then(({ code, stderr }) => {
      if (code !== 0) {
        // ffmpeg 的原始报错是英文的，转成用户能看懂的话
        if (/does not contain any stream|Output file .* does not contain/i.test(stderr)) {
          throw new Error('这个视频没有声音轨道，无法提取口播文案')
        }
        if (/No such file or directory|Error opening input/i.test(stderr)) {
          throw new Error('视频文件已失效，请重新提交')
        }
        if (/Invalid data found|moov atom not found/i.test(stderr)) {
          throw new Error('视频文件损坏或格式不支持，请换个视频试试')
        }
        console.error(`[ASR] ffmpeg 失败: ${tail(stderr)}`)
        throw new Error('音频提取失败，请换个视频试试')
      }
      // 44 字节是 WAV 文件头长度，只有头说明没抽到有效音频
      const size = fs.existsSync(wavPath) ? fs.statSync(wavPath).size : 0
      if (size <= 44) {
        throw new Error('这个视频没有声音轨道，无法提取口播文案')
      }
    })
    .catch((err) => {
      if (err.code === 'ENOENT') {
        throw new Error('服务端缺少 ffmpeg，无法从视频里抽取音频')
      }
      throw err
    })
}

/**
 * 调用 whisper.cpp 识别。
 * -otxt/-of 让它把纯文本结果写进 <前缀>.txt —— 不同版本的 whisper.cpp 把识别文字
 *   打到 stdout 还是 stderr 并不一致，读文件最稳；文件缺失时再退回读 stdout/stderr。
 * -nt 不输出时间戳、-np 不打印进度日志。
 * --prompt 用一句简体中文引导，减少输出繁体字的概率。
 */
function runWhisper(wavPath, outPrefix, txtPath) {
  const args = [
    '-m', WHISPER_MODEL,
    '-f', wavPath,
    '-l', 'zh',
    '-t', THREADS,
    '-bs', BEAM_SIZE,
    '-tp', '0',
    '-nt',
    '-np',
    '-otxt',
    '-of', outPrefix,
    '--prompt', '以下是普通话口播内容。请使用简体中文准确转写人名、数字、网络用语和完整句子，并添加自然标点。'
  ]

  return run(WHISPER_BIN, args, WHISPER_TIMEOUT_MS)
    .then(({ code, stdout, stderr }) => {
      if (code !== 0) {
        console.error(`[ASR] whisper 退出码 ${code}: ${tail(stderr)}`)
        throw new Error('语音识别失败，请稍后重试')
      }

      let raw = ''
      try {
        if (fs.existsSync(txtPath)) {
          raw = fs.readFileSync(txtPath, 'utf8')
        }
      } catch (e) {
        console.error(`[ASR] 读取识别结果文件失败: ${e.message}`)
      }
      // 兜底：没写出文件就用进程输出（stdout 优先，其次 stderr）
      if (!raw.trim()) raw = stdout
      if (!raw.trim()) raw = stderr

      return cleanText(raw)
    })
    .catch((err) => {
      if (err.code === 'ENOENT') {
        throw new Error('服务端未安装语音识别引擎（whisper-cli 未找到）')
      }
      throw err
    })
}

// whisper 自身的日志行（走 stderr 兜底时可能混进来），整段丢弃
const LOG_LINE = /^(whisper_|ggml_|main\s*:|system_info|load_backend|register_backend|usage:|error:)/i
// 形如 [00:00:00.000 --> 00:00:05.000] 的时间戳前缀
const TIMESTAMP = /^\[\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\]\s*/

/**
 * 整理 whisper 输出：丢掉日志行和时间戳，把分段拼成整段文字。
 * whisper 在纯音乐/静音处偶尔会输出 [音乐]、(掌声) 这类标注，一并清掉。
 */
function cleanText(raw) {
  return (raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !LOG_LINE.test(line))
    .map((line) => line.replace(TIMESTAMP, '').trim())
    .filter(Boolean)
    .join('')
    .replace(/[[(（【][^\])）】]{0,10}(音乐|掌声|笑声|鼓掌|BGM|Music|Applause)[^\])）】]{0,10}[\])）】]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 统一的子进程执行封装：带超时、收集 stdout/stderr，不因非 0 退出码直接 reject
 * （由调用方按业务判断），spawn 本身失败（如找不到可执行文件）才 reject。
 */
function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('识别超时，请换个短一点的视频试试'))
    }, timeoutMs)

    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err) // 保留原始 err.code(ENOENT 等)，由调用方转成友好提示
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function tail(text) {
  return (text || '').trim().slice(-300)
}

module.exports = { transcribeVideo, MAX_SECONDS }
