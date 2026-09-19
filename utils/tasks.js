const crypto = require('crypto')
const store = require('./privateStore')
const resources = require('./resources')
const running = new Map()
const LIMITS = { image: 1, caption: 1 }
const TIMEOUTS = { image: 7 * 60 * 1000, caption: 20 * 60 * 1000 }
const KEEP_MS = 24 * 60 * 60 * 1000
// 同一持久卷重启后，明确返回任务中断；不假装恢复正在运行的模型进程。
for (const task of store.list('tasks')) {
  if (task.status === 'processing') {
    task.status = 'failed'
    task.error = '服务重启导致任务中断，请重新提交'
    store.write('tasks', task.id, task)
  }
}
function problem(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e }
function response(task) {
  const data = { taskId: task.id, status: task.status, deadline: task.deadline, expiresAt: task.expiresAt }
  if (task.status === 'done') {
    if (task.kind === 'caption') data.text = task.text
    else {
      const record = resources.get(task.resourceId)
      if (!record) return { ...data, status: 'failed', error: '结果已过期，请重新处理' }
      data.resultUrl = resources.signedUrl(record)
    }
  }
  if (task.status === 'failed') data.error = task.error
  return data
}
function submit(owner, kind, requestId, payload, validate, work) {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId || '')) throw problem(400, '缺少有效的任务请求标识')
  const id = crypto.createHash('sha256').update(`${owner}:${kind}:${requestId}`).digest('hex')
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const previous = store.read('tasks', id)
  if (previous && previous.expiresAt > Date.now()) {
    if (previous.fingerprint !== fingerprint) throw problem(409, '相同请求标识不能用于不同素材')
    return response(previous)
  }
  const count = [...running.values()].filter(t => t.kind === kind).length
  if (count >= LIMITS[kind] || running.size >= 2) throw problem(429, '当前处理任务较多，请稍后再试')
  const input = validate()
  const now = Date.now()
  const task = { id, owner, kind, fingerprint, status: 'processing', deadline: now + TIMEOUTS[kind], expiresAt: now + KEEP_MS }
  store.write('tasks', id, task)
  running.set(id, task)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUTS[kind])
  timer.unref()
  Promise.resolve().then(() => work(input, controller.signal)).then(result => {
    controller.signal.throwIfAborted()
    Object.assign(task, result, { status: 'done' })
  }).catch(err => {
    task.status = 'failed'
    task.error = controller.signal.aborted ? '任务处理超时，请使用更小的素材重试' : (err.message || '处理失败，请重试')
  }).finally(() => {
    clearTimeout(timer)
    try { store.write('tasks', id, task) } catch (err) { console.error('[Task] 状态写入失败:', err.code) }
    running.delete(id)
  })
  return response(task)
}
function get(req, res) {
  const id = req.params.taskId
  const task = /^[a-f0-9]{64}$/.test(id) ? store.read('tasks', id) : null
  if (!task || task.owner !== req.owner || task.expiresAt <= Date.now()) {
    return res.status(404).json({ code: -1, msg: '任务不存在、已过期或不属于当前会话' })
  }
  res.json({ code: 0, data: response(task) })
}
function cleanExpired() {
  for (const task of store.list('tasks')) if (task.expiresAt <= Date.now() && !running.has(task.id)) store.remove('tasks', task.id)
}
module.exports = { submit, get, cleanExpired }
