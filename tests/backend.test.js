const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoaii-backend-test-'))
process.env.APP_DATA_DIR = testDir
delete process.env.PRIVATE_STATE_DIR
process.env.SHILIU_API_KEY = ''
process.env.DASHSCOPE_API_KEY = ''
const sharp = require('sharp')
const store = require('../utils/privateStore')
const resources = require('../utils/resources')
const tasks = require('../utils/tasks')
const runtime = require('../utils/runtimePaths')
const worker = require('../utils/imageInpaintWorker')
const realWorker = worker.removeWatermarkInWorker
let copiedVideo = ''
require('../utils/asrClient').transcribeVideo = async mediaPath => {
  copiedVideo = mediaPath
  assert.ok(mediaPath.startsWith(runtime.workDir + path.sep))
  assert.ok(fs.existsSync(mediaPath))
  return '测试口播'
}
// Infrastructure tests do not invoke external AI services or consume paid requests.
worker.removeWatermarkInWorker = async () => { throw new Error('unexpected image task') }
const app = require('../app')
const server = app.listen(0, '127.0.0.1')
const ready = new Promise(resolve => server.once('listening', resolve))
async function call(route, { token, body, method = 'GET' } = {}) {
  await ready
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: response.status, body: await response.json() }
}
async function session(token) { return (await call('/api/session', { method: 'POST', token })).body.data.token }
async function upload(token, bytes, name, type) {
  await ready
  const form = new FormData(); form.append('file', new Blob([bytes], { type }), name)
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  return { status: r.status, body: await r.json() }
}
const turn = () => new Promise(resolve => setImmediate(resolve))
after(async () => {
  await new Promise(resolve => server.close(resolve))
  // Only remove the exact temporary directory created above, never workspace data.
  assert.equal(path.dirname(testDir), os.tmpdir())
  assert.ok(path.basename(testDir).startsWith('xiaoaii-backend-test-'))
  fs.rmSync(testDir, { recursive: true, force: true })
})

test('auth, cross-owner and wrong-kind requests reject without deleting uploads', async () => {
  const a = await session(), b = await session()
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000' } }).png().toBuffer()
  const up = await upload(a, png, 'photo.png', 'image/png')
  assert.equal(up.status, 200)
  const id = up.body.data.url, record = resources.get(id)
  assert.ok(record.path.startsWith(runtime.uploadsDir + path.sep))
  const input = { imageUrl: id, maskUrl: id, requestId: 'cross_owner_check_01' }
  assert.equal((await call('/api/image/remove-watermark', { method: 'POST', body: input })).status, 401)
  assert.equal((await call('/api/image/remove-watermark', { method: 'POST', token: b, body: input })).status, 403)
  assert.equal((await call('/api/caption/extract', { method: 'POST', token: a, body: { videoUrl: id, requestId: 'wrong_kind_check_01' } })).status, 403)
  assert.ok(fs.existsSync(record.path))
  assert.equal((await call('/uploads/' + path.basename(record.path))).status, 404)
})

test('signature validates bytes, rejects tampering and expired tokens', async () => {
  const file = path.join(runtime.uploadsDir, 'signature-test.png'); fs.writeFileSync(file, 'test-content')
  const record = resources.register(file, 'owner', 'result')
  const url = resources.signedUrl(record)
  await ready
  const base = `http://127.0.0.1:${server.address().port}`
  const good = await fetch(base + url); assert.equal(good.status, 200); assert.equal(await good.text(), 'test-content')
  assert.equal((await call(url.replace(/token=.*/, 'token=' + '汉'.repeat(64)))).status, 403)
  assert.equal((await call(resources.signedUrl(record, -1))).status, 403)
  assert.equal(store.equal('汉'.repeat(64), 'a'.repeat(64)), false)
})

test('valid recently expired session renews the same owner; forged token cannot', async () => {
  const owner = crypto.randomUUID(), expires = Date.now() - 1000, payload = `${owner}.${expires}`
  const expired = `${payload}.${store.sign(payload)}`
  assert.equal((await call('/api/caption/result/' + 'a'.repeat(64), { token: expired })).status, 401)
  const renewed = await session(expired)
  assert.equal(renewed.split('.')[0], owner)
  const forged = await session(`${payload}.${'a'.repeat(64)}`)
  assert.notEqual(forged.split('.')[0], owner)
})

test('caption uses an isolated copy, deletes only that copy, and binds polling to owner', async () => {
  const token = await session()
  const video = Buffer.alloc(64); video.write('ftyp', 4)
  const uploaded = await upload(token, video, 'sample.mp4', 'video/mp4')
  const original = resources.get(uploaded.body.data.url).path
  const submit = await call('/api/caption/extract', { method: 'POST', token, body: { videoUrl: uploaded.body.data.url, requestId: 'copy_video_check_01' } })
  assert.equal(submit.status, 200)
  let result
  for (let i = 0; i < 20; i++) {
    result = await call('/api/caption/result/' + submit.body.data.taskId, { token })
    if (result.body.data.status !== 'processing') break
    await turn()
  }
  assert.equal(result.body.data.status, 'done'); assert.equal(result.body.data.text, '测试口播')
  assert.ok(fs.existsSync(original)); assert.ok(!fs.existsSync(copiedVideo))
  const other = await session()
  assert.equal((await call('/api/caption/result/' + submit.body.data.taskId, { token: other })).status, 404)
})

test('capacity, idempotent retry and payload mismatch are enforced before work', async () => {
  let release, calls = 0
  const work = () => { calls++; return new Promise(resolve => { release = resolve }) }
  const first = tasks.submit('owner', 'image', 'same_request_check_01', { value: 1 }, () => null, work)
  const again = tasks.submit('owner', 'image', 'same_request_check_01', { value: 1 }, () => null, work)
  assert.equal(first.taskId, again.taskId)
  assert.throws(() => tasks.submit('owner', 'image', 'same_request_check_01', { value: 2 }, () => null, work), e => e.statusCode === 409)
  assert.throws(() => tasks.submit('other', 'image', 'other_request_check01', {}, () => null, work), e => e.statusCode === 429)
  await turn(); assert.equal(calls, 1); release({}); await turn()
})

test('expired in-use resource remains on disk but cannot be downloaded, then is cleaned', () => {
  const file = path.join(runtime.uploadsDir, 'expiry-test.png'); fs.writeFileSync(file, 'private')
  const record = resources.register(file, 'owner', 'image')
  resources.pin(record.id); record.expiresAt = Date.now() - 1; store.write('resources', record.id, record)
  resources.cleanExpired(); assert.ok(fs.existsSync(file)); assert.equal(resources.get(record.id), null)
  assert.ok(resources.protectedPaths().has(file))
  resources.unpin(record.id); resources.cleanExpired(); assert.equal(fs.existsSync(file), false)
})

test('restart marks unfinished task failed without discarding completed result', () => {
  const pendingId = 'd'.repeat(64), completeId = 'e'.repeat(64)
  store.write('tasks', pendingId, { id: pendingId, status: 'processing', expiresAt: Date.now() + 10000 })
  store.write('tasks', completeId, { id: completeId, status: 'done', text: 'keep', expiresAt: Date.now() + 10000 })
  execFileSync(process.execPath, ['-e', 'require("./utils/tasks")'], { cwd: path.join(__dirname, '..'), windowsHide: true, env: process.env })
  assert.equal(store.read('tasks', pendingId).status, 'failed')
  assert.equal(store.read('tasks', completeId).text, 'keep')
})

test('invalid JSON body returns 400 rather than misleading startup error', async () => {
  await ready
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/caption/extract`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })
  assert.equal(r.status, 400)
})

test('server download rejects arbitrary localhost and relative paths', async () => {
  const { downloadVideo } = require('../utils/mediaFetch')
  await assert.rejects(downloadVideo('http://127.0.0.1/private'), /不受支持/)
  await assert.rejects(downloadVideo('/private-file'), /非法/)
})

test('server download unwraps allowed proxy URL and validates redirects', async () => {
  const axios = require('axios'), original = axios.get
  const { Readable } = require('stream')
  const { downloadVideo } = require('../utils/mediaFetch')
  let target
  axios.get = async (url, options) => {
    target = url
    assert.throws(() => options.beforeRedirect({ protocol: 'http:', hostname: '127.0.0.1', path: '/' }), /非白名单/)
    return { data: Readable.from([Buffer.alloc(2048)]) }
  }
  try {
    const file = await downloadVideo('/api/video/proxy?url=' + encodeURIComponent('https://v.douyinvod.com/test.mp4'))
    assert.equal(target, 'https://v.douyinvod.com/test.mp4')
    assert.equal(fs.statSync(file).size, 2048)
    assert.ok(file.startsWith(runtime.workDir + path.sep))
  } finally { axios.get = original }
})

test('interrupted server download closes stream and cleans its partial file', async () => {
  const axios = require('axios'), original = axios.get
  const { Readable } = require('stream')
  const { downloadVideo } = require('../utils/mediaFetch')
  const before = fs.readdirSync(runtime.workDir).sort()
  axios.get = async () => ({ data: Readable.from((async function * () { yield Buffer.alloc(2048); throw new Error('connection broken') })()) })
  try {
    await assert.rejects(downloadVideo('https://v.douyinvod.com/test.mp4'), /connection broken/)
    assert.deepEqual(fs.readdirSync(runtime.workDir).sort(), before)
  } finally { axios.get = original }
})

test('real local image worker produces a decodable file under configured data directory', async () => {
  const image = path.join(runtime.uploadsDir, 'worker-input.png'), mask = path.join(runtime.uploadsDir, 'worker-mask.png')
  await sharp({ create: { width: 32, height: 32, channels: 4, background: '#aabbcc' } }).png().toFile(image)
  await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toFile(mask)
  const result = await realWorker(image, mask)
  const info = await sharp(result).metadata()
  assert.equal(info.width, 32); assert.equal(info.height, 32)
  assert.ok(result.startsWith(runtime.uploadsDir + path.sep))
})
