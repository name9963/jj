// server/utils/secCheck.js
// 微信内容安全检测（UGC 合规要求）
//
// 背景：微信要求所有 UGC（用户上传内容）场景接入内容安全 API，
// 未接入会被审核拒绝（违反《微信小程序平台运营规范常见拒绝情形 3.2》）。
//
// 实现要点：
//   * access_token 需要缓存（微信限制获取频率，且有效期 7200s）
//   * imgSecCheck(v1) 要求图片 ≤ 1MB，因此先用 sharp 迭代压缩到阈值内
//   * 检测不通过时调用方只提示「内容含违规信息」，不暴露具体原因（审核明确要求）
//
// 环境变量：
//   WX_APPID   小程序 AppID
//   WX_SECRET  小程序 AppSecret（在小程序后台「开发管理-开发设置」生成）
const axios = require('axios')
const sharp = require('sharp')
const fs = require('fs')

const API_BASE = 'https://api.weixin.qq.com'
const IMG_MAX_BYTES = 1024 * 1024 // v1 imgSecCheck 限制 1MB

// access_token 缓存：微信侧有效期 7200s，提前 5 分钟过期以留安全边界
let tokenCache = { value: '', expiresAt: 0 }

function isConfigured() {
  return Boolean(process.env.WX_APPID && process.env.WX_SECRET)
}

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value

  const appid = process.env.WX_APPID
  const secret = process.env.WX_SECRET
  if (!appid || !secret) throw new Error('未配置 WX_APPID / WX_SECRET')

  const { data } = await axios.get(`${API_BASE}/cgi-bin/token`, {
    params: { grant_type: 'client_credential', appid, secret },
    timeout: 10000
  })
  if (!data.access_token) {
    throw new Error(`获取 access_token 失败：${data.errcode} ${data.errmsg}`)
  }
  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000
  }
  return tokenCache.value
}

/**
 * 把图片压缩到 1MB 以内（v1 imgSecCheck 的硬限制）。
 * 逐级降低质量与尺寸，最多尝试若干轮；仍超限则返回 null。
 */
async function shrinkToLimit(filePath) {
  const attempts = [
    { maxEdge: 1280, quality: 80 },
    { maxEdge: 1024, quality: 70 },
    { maxEdge: 800, quality: 60 },
    { maxEdge: 600, quality: 50 }
  ]
  for (const { maxEdge, quality } of attempts) {
    const buf = await sharp(filePath, { failOn: 'none' })
      .rotate() // 按 EXIF 摆正，避免压缩后方向异常
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer()
    if (buf.length <= IMG_MAX_BYTES) return buf
  }
  return null
}

/**
 * 检测图片是否安全。
 * @returns {Promise<{safe:boolean, reason?:string}>}
 *   safe=true  内容安全
 *   safe=false 含违规内容（调用方只提示「内容含违规信息」）
 * @throws 检测服务本身异常（网络/配置问题）时抛出，由调用方决定放行或拦截
 */
async function checkImage(filePath) {
  const token = await getAccessToken()

  let body
  try {
    body = await shrinkToLimit(filePath)
  } catch (e) {
    // 非图片（如视频）或 sharp 无法解析：此路径不应被调用，交由调用方按类型跳过
    throw new Error(`图片预处理失败：${e.message}`)
  }
  if (!body) throw new Error('图片压缩后仍超过 1MB，无法送检')

  // 微信 v1 接口要求 multipart/form-data，字段名为 media
  const form = new FormData()
  form.append('media', new Blob([body], { type: 'image/jpeg' }), 'check.jpg')

  const { data } = await axios.post(
    `${API_BASE}/wxa/img_sec_check?access_token=${token}`,
    form,
    { timeout: 15000, headers: { 'Content-Type': 'multipart/form-data' } }
  )

  // errcode 0 通过；87014 内容含违规；其余为接口异常
  if (data.errcode === 0) return { safe: true }
  if (data.errcode === 87014) return { safe: false, reason: 'risky' }
  throw new Error(`imgSecCheck 异常：${data.errcode} ${data.errmsg}`)
}

/**
 * 检测文本是否安全（用于用户输入的分享链接/标题等）。
 * v2 接口需要 openid 与 scene；本项目无登录体系，因此 openid 使用固定占位值，
 * 对纯链接文本的违规识别依然有效。
 * @returns {Promise<{safe:boolean, reason?:string}>}
 */
async function checkText(content, openid = 'anonymous') {
  const text = String(content || '').trim()
  if (!text) return { safe: true }

  const token = await getAccessToken()
  const { data } = await axios.post(
    `${API_BASE}/wxa/msg_sec_check?access_token=${token}`,
    { version: 2, openid, scene: 2, content: text.slice(0, 2500) },
    { timeout: 15000 }
  )

  // v2 返回 result.suggest：pass / review / risky
  const suggest = data && data.result && data.result.suggest
  if (suggest === 'pass') return { safe: true }
  if (suggest === 'risky' || suggest === 'review') return { safe: false, reason: suggest }
  if (data.errcode === 0) return { safe: true }
  throw new Error(`msgSecCheck 异常：${data.errcode} ${data.errmsg}`)
}

/**
 * 按文件类型分派检测：图片走 imgSecCheck，其他类型（视频等）暂不送检。
 * @param {string} filePath 本地文件路径
 * @param {string} mimeType 文件 MIME
 * @returns {Promise<{skipped?:boolean, safe:boolean, reason?:string}>}
 */
async function checkUpload(filePath, mimeType) {
  if (!isConfigured()) {
    // 未配置时明确抛出，让调用方决定策略（本项目选择放行并记录告警，
    // 避免因缺配置导致全部上传不可用；正式环境务必配置）
    throw new Error('未配置 WX_APPID / WX_SECRET，内容安全检测不可用')
  }
  if (!/^image\//i.test(mimeType || '')) {
    return { skipped: true, safe: true }
  }
  if (!fs.existsSync(filePath)) throw new Error('待检测文件不存在')
  return checkImage(filePath)
}

module.exports = { checkUpload, checkImage, checkText, isConfigured, getAccessToken }
