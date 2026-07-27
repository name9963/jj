// server/utils/security.js
// 轻量安全中间件：安全响应头 + 单实例请求限流。
// 云托管多实例场景仍建议在网关/WAF 层再配置一层全局限流。

const buckets = new Map()
let requestCount = 0

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Cache-Control', 'no-store')
  res.removeHeader('X-Powered-By')
  next()
}

function createRateLimiter({ windowMs = 10 * 60 * 1000, max = 100, name = 'api' } = {}) {
  return (req, res, next) => {
    const now = Date.now()
    const client = req.ip || req.socket.remoteAddress || 'unknown'
    const key = `${name}:${client}`
    let bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
    }

    bucket.count++
    res.setHeader('X-RateLimit-Limit', String(max))
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)))
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)))

    requestCount++
    if (requestCount % 500 === 0) cleanExpired(now)

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(429).json({
        code: -1,
        msg: '操作太频繁，请稍后再试',
        data: { retryAfter }
      })
    }

    next()
  }
}

function cleanExpired(now = Date.now()) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

module.exports = { securityHeaders, createRateLimiter }
