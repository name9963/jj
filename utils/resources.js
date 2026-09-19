const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const store = require('./privateStore')
const RETENTION_MS = 24 * 60 * 60 * 1000
const active = new Map()
function pin(id) { active.set(id, (active.get(id) || 0) + 1) }
function unpin(id) { const count = (active.get(id) || 0) - 1; if (count > 0) active.set(id, count); else active.delete(id) }
function register(filePath, owner, kind) {
  const record = { id: crypto.randomUUID(), path: path.resolve(filePath), owner, kind, expiresAt: Date.now() + RETENTION_MS }
  store.write('resources', record.id, record)
  return record
}
function get(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return null
  const record = store.read('resources', id)
  return record && record.expiresAt > Date.now() && fs.existsSync(record.path) ? record : null
}
function owned(id, owner, kind) {
  const record = get(id)
  if (!record || record.owner !== owner || record.kind !== kind) {
    const err = new Error('素材无效、已过期或不属于当前会话，请重新选择并上传')
    err.statusCode = 403
    throw err
  }
  return record
}
function signedUrl(record, ttl = 15 * 60 * 1000) {
  const expires = Math.min(Date.now() + ttl, record.expiresAt)
  const token = store.sign(`${record.id}.${expires}`)
  return `/api/files/${record.id}?expires=${expires}&token=${token}`
}
function serve(req, res, next) {
  const record = get(req.params.id)
  const expires = String(req.query.expires || '')
  if (!record || !/^\d{13}$/.test(expires) || Number(expires) <= Date.now() || Number(expires) > record.expiresAt ||
      !store.equal(String(req.query.token || ''), store.sign(`${record.id}.${expires}`))) {
    return res.status(403).json({ code: -1, msg: '下载地址无效或已过期，请重新获取结果' })
  }
  res.sendFile(record.path, { headers: { 'Cache-Control': 'no-store' } }, err => { if (err) next(err) })
}
function revoke(id) {
  const record = store.read('resources', id)
  if (!record) return
  try { fs.unlinkSync(record.path) } catch (err) { if (err.code !== 'ENOENT') throw err }
  store.remove('resources', id)
}
function cleanExpired() {
  for (const record of store.list('resources')) {
    if (record.expiresAt <= Date.now() && !active.has(record.id)) {
      try { revoke(record.id) } catch (err) { console.error('[Cleaner] 资源删除失败，将重试:', err.code) }
    }
  }
}
function protectedPaths() {
  return new Set(store.list('resources').filter(record => record.expiresAt > Date.now() || active.has(record.id)).map(record => record.path))
}
module.exports = { register, get, owned, signedUrl, serve, revoke, cleanExpired, RETENTION_MS, pin, unpin, protectedPaths }
