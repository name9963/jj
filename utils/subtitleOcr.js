// server/utils/subtitleOcr.js
// 视频硬字幕 OCR 提取（离线 Tesseract）。
// 短视频字幕多为烧进画面的"硬字幕"，无独立字幕轨，只能抽帧后对画面做 OCR。
// 流程：ffmpeg 抽帧(限时长) + 裁底部字幕区 + 放大转灰度 → 逐帧 tesseract(chi_sim)
//      → 清洗/过滤水印噪声 → 相邻去重 → 判定是否真有字幕。
// 若判定无字幕或识别内容太少，返回 { ok:false }，由上层回退到语音识别。
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TESSERACT_BIN = process.env.TESSERACT_BIN || 'tesseract'
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg'
const MAX_SECONDS = Number(process.env.ASR_MAX_SECONDS || 180) // 与语音识别保持一致
const FRAME_INTERVAL = Number(process.env.OCR_FRAME_INTERVAL || 0.8) // 每隔多少秒抽一帧
const MAX_FRAMES = Number(process.env.OCR_MAX_FRAMES || 200) // 抽帧上限，防超长视频
// 字幕通常在画面下部：裁底部 35%（从 65% 高度到底），减少画面主体干扰
const CROP_TOP_RATIO = 0.65
const CROP_HEIGHT_RATIO = 0.35
// 判定"有字幕"：有效帧占比阈值 + 至少要有几条不同字幕
const MIN_VALID_FRAME_RATIO = 0.3
const MIN_DISTINCT_LINES = 2
const MIN_CJK_RATIO = Number(process.env.OCR_MIN_CJK_RATIO || 0.85)
const MAX_NOISE_RATIO = Number(process.env.OCR_MAX_NOISE_RATIO || 0.12)
const MAX_SINGLE_CHAR_RATIO = Number(process.env.OCR_MAX_SINGLE_CHAR_RATIO || 0.25)
const MAX_DUPLICATE_RATIO = Number(process.env.OCR_MAX_DUPLICATE_RATIO || 0.65)

const FFMPEG_TIMEOUT_MS = 4 * 60 * 1000
const TESS_TIMEOUT_MS = 20 * 1000

// 常见水印/平台标识，命中则丢弃（避免把 @昵称、平台名当字幕）
const WATERMARK_RE = /(快手|抖音|极速版|作品|已被播放|点击链接|打开【|视频号|小红书|@)/

/**
 * 提取视频硬字幕文本。
 * @param {string} videoPath 服务器本地视频路径
 * @returns {Promise<{ok:boolean, text?:string, lines?:number}>}
 */
async function extractSubtitleText(videoPath) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr_'))
  try {
    await extractFrames(videoPath, workDir)

    const frames = fs.readdirSync(workDir)
      .filter(f => f.endsWith('.png'))
      .sort()
      .slice(0, MAX_FRAMES)

    if (frames.length === 0) return { ok: false }

    const ordered = [] // 逐帧有效文本行（按时间顺序）
    let validFrames = 0
    for (const f of frames) {
      const raw = await ocrImage(path.join(workDir, f)).catch(err => {
        if (err && err.code === 'ENOENT') {
          throw new Error('服务端未安装字幕识别引擎（tesseract 未找到）')
        }
        return ''
      })
      const lines = cleanLines(raw)
      if (lines.length > 0) validFrames++
      for (const ln of lines) ordered.push(ln)
    }

    // 相邻去重：同一句字幕会连续出现在多帧
    const deduped = dedupLines(ordered)

    // 除了“识别到了字”，还必须通过可读性评分。旧逻辑只看汉字数量，
    // 画面纹理误识别出的随机汉字也会被当成字幕，导致自动模式输出整段乱码。
    const validRatio = validFrames / frames.length
    const quality = evaluateSubtitleQuality(deduped)
    if (validRatio < MIN_VALID_FRAME_RATIO || deduped.length < MIN_DISTINCT_LINES || !quality.ok) {
      console.log(`[SubtitleOCR] 结果质量不足，回退语音识别: ${JSON.stringify(quality)}`)
      return { ok: false, quality }
    }

    return { ok: true, text: formatSubtitleText(deduped), lines: deduped.length, quality }
  } finally {
    // 清理临时帧
    try {
      for (const f of fs.readdirSync(workDir)) fs.unlinkSync(path.join(workDir, f))
      fs.rmdirSync(workDir)
    } catch { /* ignore */ }
  }
}

/** ffmpeg 抽帧：限时长、裁底部字幕区、放大2倍转灰度，提升 OCR 命中率 */
function extractFrames(videoPath, outDir) {
  const vf = [
    `fps=1/${FRAME_INTERVAL}`,
    `crop=iw:ih*${CROP_HEIGHT_RATIO}:0:ih*${CROP_TOP_RATIO}`,
    'scale=iw*2:-2',
    'format=gray'
  ].join(',')

  const args = [
    '-y', '-loglevel', 'error',
    '-t', String(MAX_SECONDS),
    '-i', videoPath,
    '-vf', vf,
    '-frames:v', String(MAX_FRAMES),
    path.join(outDir, 'f_%04d.png')
  ]
  return run(FFMPEG_BIN, args, FFMPEG_TIMEOUT_MS)
    .then(({ code, stderr }) => {
      if (code !== 0) throw new Error(`ffmpeg抽帧失败: ${stderr.slice(-200)}`)
    })
    .catch(err => {
      if (err && err.code === 'ENOENT') {
        throw new Error('服务端缺少 ffmpeg，无法抽取视频画面')
      }
      throw err
    })
}

/** 对单帧做 OCR。psm 6：把裁剪区当作统一文本块；chi_sim 简体中文 */
function ocrImage(imgPath) {
  const args = [imgPath, 'stdout', '-l', 'chi_sim', '--psm', '6']
  return run(TESSERACT_BIN, args, TESS_TIMEOUT_MS).then(({ code, stdout }) => {
    if (code !== 0) return ''
    return stdout || ''
  })
}

/**
 * 清洗单帧 OCR 结果为有效字幕行：
 * 只保留含 >=2 个中文字符的行，去掉空白/水印/纯符号噪声。
 */
function cleanLines(raw) {
  return (raw || '')
    .split('\n')
    .map(s => s.replace(/\s+/g, '').trim())
    .filter(s => {
      if (!s) return false
      const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length
      if (cjk < 2) return false          // 中文太少，多半是噪声
      if (WATERMARK_RE.test(s)) return false // 水印/平台标识
      return true
    })
}

function evaluateSubtitleQuality(lines) {
  const text = lines.join('')
  const chars = Array.from(text)
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const usefulCount = (text.match(/[\u4e00-\u9fffA-Za-z0-9，。！？、：“”‘’；：,.!?-]/g) || []).length
  const noiseCount = Math.max(0, chars.length - usefulCount)
  const cjkRatio = chars.length ? cjkCount / chars.length : 0
  const noiseRatio = chars.length ? noiseCount / chars.length : 1
  const singleCharRatio = lines.length
    ? lines.filter(line => (line.match(/[\u4e00-\u9fff]/g) || []).length <= 2).length / lines.length
    : 1

  const normalized = lines.map(line => line.replace(/[，。！？、：“”‘’；：,.!?\s]/g, ''))
  const uniqueCount = new Set(normalized).size
  const duplicateRatio = lines.length ? 1 - uniqueCount / lines.length : 1
  const averageLineLength = lines.length ? cjkCount / lines.length : 0

  const ok = text.length >= 8 &&
    cjkRatio >= MIN_CJK_RATIO &&
    noiseRatio <= MAX_NOISE_RATIO &&
    singleCharRatio <= MAX_SINGLE_CHAR_RATIO &&
    duplicateRatio <= MAX_DUPLICATE_RATIO &&
    averageLineLength >= 3

  return {
    ok,
    cjkRatio: Number(cjkRatio.toFixed(2)),
    noiseRatio: Number(noiseRatio.toFixed(2)),
    singleCharRatio: Number(singleCharRatio.toFixed(2)),
    duplicateRatio: Number(duplicateRatio.toFixed(2)),
    averageLineLength: Number(averageLineLength.toFixed(1))
  }
}

function formatSubtitleText(lines) {
  return lines.map(line => /[。！？!?]$/.test(line) ? line : `${line}。`).join('')
}

/** 相邻去重：连续帧的相同/高度相似字幕只保留一条（保留更长的那条） */
function dedupLines(lines) {
  const out = []
  for (const cur of lines) {
    if (out.length === 0) { out.push(cur); continue }
    const prev = out[out.length - 1]
    if (similar(prev, cur)) {
      if (cur.length > prev.length) out[out.length - 1] = cur // 取更完整的
    } else {
      out.push(cur)
    }
  }
  return out
}

/** 两行是否"同一句字幕"：互为子串，或编辑距离相似度 >= 0.8 */
function similar(a, b) {
  if (a === b) return true
  if (a.includes(b) || b.includes(a)) return true
  const dist = levenshtein(a, b)
  const ratio = 1 - dist / Math.max(a.length, b.length)
  return ratio >= 0.8
}

function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let cur = new Array(n + 1)
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    [prev, cur] = [cur, prev]
  }
  return prev[n]
}

/** 子进程执行封装：带超时，收集 stdout/stderr；spawn 本身失败(如找不到可执行文件)才 reject */
function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = '', stderr = '', settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('OCR/抽帧超时'))
    }, timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString('utf8') })
    child.stderr.on('data', d => { stderr += d.toString('utf8') })
    child.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err) })
    child.on('close', (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

module.exports = { extractSubtitleText, evaluateSubtitleQuality, formatSubtitleText }
