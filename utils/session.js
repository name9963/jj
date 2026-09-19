const crypto = require('crypto')
const store = require('./privateStore')
const SESSION_MS = 30 * 24 * 60 * 60 * 1000
function createSession(req, res) {
  // 会话刚过期时，持有原签名的人可续期，保留尚未过期资源的所有权。
  const previous = verify(req.get('Authorization'), 24 * 60 * 60 * 1000)
  const owner = previous ? previous.owner : crypto.randomUUID()
  const expiresAt = Date.now() + SESSION_MS
  const payload = `${owner}.${expiresAt}`
  res.json({ code: 0, data: { token: `${payload}.${store.sign(payload)}`, expiresAt } })
}
function requireSession(req, res, next) {
  const verified = verify(req.get('Authorization'))
  if (!verified) {
    return res.status(401).json({ code: -1, msg: '会话已失效，请重新进入后上传素材' })
  }
  req.owner = verified.owner
  next()
}
function verify(header, graceMs = 0) {
  const token = (header || '').replace(/^Bearer /, '')
  const match = token.match(/^([a-f0-9-]{36})\.(\d{13})\.([a-f0-9]{64})$/)
  if (!match || Number(match[2]) + graceMs <= Date.now() || !store.equal(match[3], store.sign(`${match[1]}.${match[2]}`))) return null
  return { owner: match[1] }
}
module.exports = { createSession, requireSession }
