// 单实例的私有持久状态。生产需挂载持久卷；禁止多个进程同时写此目录。
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ROOT = require('./runtimePaths').stateDir
fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
function file(bucket, id) {
  if (!/^[a-z]+$/.test(bucket) || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid state key')
  const dir = path.join(ROOT, bucket)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return path.join(dir, `${id}.json`)
}
function read(bucket, id) {
  try { return JSON.parse(fs.readFileSync(file(bucket, id), 'utf8')) } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}
function write(bucket, id, value) {
  const dest = file(bucket, id)
  const temp = `${dest}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(temp, dest)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}
function remove(bucket, id) { fs.rmSync(file(bucket, id), { force: true }) }
function list(bucket) {
  const dir = path.dirname(file(bucket, '_'))
  return fs.readdirSync(dir).filter(n => /^[a-zA-Z0-9_-]+\.json$/.test(n)).flatMap(n => {
    try { const value = read(bucket, n.slice(0, -5)); return value ? [value] : [] } catch (err) {
      console.error('[State] 状态记录无法读取，已跳过:', bucket, n, err.code || err.name)
      return []
    }
  })
}
const keyFile = path.join(ROOT, 'signing.key')
try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }) } catch (err) {
  if (err.code !== 'EEXIST') throw err
}
const key = fs.readFileSync(keyFile)
function sign(value) { return crypto.createHmac('sha256', key).update(value).digest('hex') }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}
module.exports = { read, write, remove, list, sign, equal }
