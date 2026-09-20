// 线上冒烟测试：健康检查 + 路由就位 + 图片去水印端到端
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const BASE = (process.env.TEST_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
let AUTH = {}

async function jpost(url, body) {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  return { status: r.status, data: await r.json().catch(() => null) }
}

async function jget(url) {
  const r = await fetch(BASE + url, { headers: AUTH, signal: AbortSignal.timeout(30000) })
  return { status: r.status, data: await r.json().catch(() => null) }
}

async function uploadFile(filePath, name) {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(filePath)]), name)
  const r = await fetch(BASE + '/api/upload', { method: 'POST', headers: AUTH, body: fd, signal: AbortSignal.timeout(60000) })
  const data = await r.json()
  if (data.code !== 0) throw new Error('上传失败: ' + JSON.stringify(data))
  return data.data.url
}

async function main() {
  // 1. 健康检查
  const health = await jget('/')
  console.log('1) 健康检查:', health.status, JSON.stringify(health.data))

  const session = await fetch(BASE + '/api/session', { method: 'POST', signal: AbortSignal.timeout(30000) })
  const sessionData = await session.json()
  if (!sessionData.data || !sessionData.data.token) throw new Error('无法建立安全会话')
  AUTH = { Authorization: `Bearer ${sessionData.data.token}` }

  // 2. caption 路由就位（空参应返回业务错误而非 404）
  const cap = await jpost('/api/caption/extract', {})
  console.log('2) caption路由:', cap.status, JSON.stringify(cap.data))

  // 3. 图片去水印端到端
  const imgPath = path.join(__dirname, 'uploads', 'test_image.png')
  const { width, height } = await sharp(imgPath).metadata()

  // 生成红色画笔风格遮罩（与前端 canvas 导出一致：透明底+半透明红块）
  const maskPath = path.join(__dirname, 'uploads', 'live_test_mask.png')
  const rect = await sharp({
    create: { width: Math.round(width * 0.4), height: Math.round(height * 0.2), channels: 4, background: { r: 255, g: 80, b: 80, alpha: 0.5 } }
  }).png().toBuffer()
  await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: rect, left: Math.round(width * 0.3), top: Math.round(height * 0.4) }])
    .png().toFile(maskPath)

  const imageUrl = await uploadFile(imgPath, 'test_image.png')
  const maskUrl = await uploadFile(maskPath, 'live_test_mask.png')
  console.log('3) 上传成功:', imageUrl, maskUrl)

  const task = await jpost('/api/image/remove-watermark', {
    imageUrl, maskUrl, width, height,
    requestId: `live_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  })
  console.log('4) 建任务:', JSON.stringify(task.data))
  const taskId = task.data && task.data.data && task.data.data.taskId
  if (!taskId) throw new Error('未拿到 taskId')

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const res = await jget(`/api/image/result/${taskId}`)
    const st = res.data && res.data.data && res.data.data.status
    process.stdout.write(`   轮询#${i + 1}: ${st}\n`)
    if (st === 'done') {
      const url = res.data.data.resultUrl
      const img = await fetch(BASE + url, { signal: AbortSignal.timeout(30000) })
      const buf = Buffer.from(await img.arrayBuffer())
      console.log(`5) ✓ 去水印完成: ${url} (${buf.length} bytes, HTTP ${img.status})`)
      fs.unlinkSync(maskPath)
      return
    }
    if (st === 'failed') throw new Error('任务失败: ' + JSON.stringify(res.data))
  }
  throw new Error('轮询超时')
}

main().then(() => console.log('\n=== 线上冒烟测试全部通过 ===')).catch(e => { console.error('\nFAILED:', e.message); process.exit(1) })
