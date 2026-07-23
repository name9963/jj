// server/utils/aliyunErase.js
// 阿里云智能消除 API 封装
// 文档: https://help.aliyun.com/zh/document_detail/3038061.html
const crypto = require('crypto')
const https = require('https')
const fs = require('fs')
const path = require('path')

const ENDPOINT = 'https://aidge.cn-hangzhou.aliyuncs.com'
const API_PATH = '/rest/ai/image/remove'

/**
 * 生成阿里云 API 签名 (ACS3-HMAC-SHA256)
 */
function signRequest(method, path, headers, body, accessKeySecret) {
  // 构造规范化请求
  const sortedHeaders = Object.keys(headers)
    .filter(k => k.startsWith('x-acs-') || k === 'host' || k === 'content-type')
    .sort()

  const canonicalHeaders = sortedHeaders
    .map(k => `${k}:${headers[k].trim()}`)
    .join('\n') + '\n'

  const signedHeaders = sortedHeaders.join(';')

  const hashedBody = crypto.createHash('sha256').update(body || '').digest('hex')

  const canonicalRequest = [
    method,
    path,
    '',  // query string (empty for POST)
    canonicalHeaders,
    signedHeaders,
    hashedBody
  ].join('\n')

  // 构造待签名字符串
  const hashedCanonical = crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  const stringToSign = `ACS3-HMAC-SHA256\n${hashedCanonical}`

  // 计算签名
  const signature = crypto.createHmac('sha256', accessKeySecret)
    .update(stringToSign)
    .digest('hex')

  return { signature, signedHeaders }
}

/**
 * 调用阿里云智能消除 API
 * @param {string} imageUrl - 图片的公网可访问URL
 * @returns {Promise<string>} 处理后图片的URL
 */
async function removeWatermarkAliyun(imageUrl) {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET

  if (!accessKeyId || !accessKeySecret) {
    throw new Error('未配置阿里云密钥')
  }

  const body = JSON.stringify({
    ImageUrl: imageUrl,
    // 消除非主体区域的透明字块(1)和文字(3)
    NonObjectRemoveElements: [1, 3]
  })

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const nonce = crypto.randomUUID()

  const urlObj = new URL(ENDPOINT)
  const headers = {
    'host': urlObj.host,
    'content-type': 'application/json',
    'x-acs-action': 'ImageRemove',
    'x-acs-version': '2024-11-15',
    'x-acs-date': now,
    'x-acs-signature-nonce': nonce,
    'x-acs-content-sha256': crypto.createHash('sha256').update(body).digest('hex')
  }

  const { signature, signedHeaders } = signRequest('POST', API_PATH, headers, body, accessKeySecret)

  headers['Authorization'] = `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`

  // 发送请求
  const result = await httpRequest(ENDPOINT + API_PATH, {
    method: 'POST',
    headers,
    body
  })

  const data = JSON.parse(result)

  if (data.Success && data.Data && data.Data.ImageUrl) {
    return data.Data.ImageUrl
  }

  throw new Error(data.Message || data.Code || '阿里云API调用失败')
}

/**
 * 下载远程图片到本地
 */
async function downloadImage(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath)
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve(outputPath) })
    }).on('error', reject)
  })
}

/**
 * 完整流程：调用API → 下载结果 → 返回本地路径
 */
async function removeWatermarkAndSave(imageUrl) {
  const resultUrl = await removeWatermarkAliyun(imageUrl)

  const outputDir = path.join(__dirname, '..', 'uploads')
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  const outputPath = path.join(outputDir, `result_${Date.now()}.png`)

  await downloadImage(resultUrl, outputPath)
  return outputPath
}

function httpRequest(url, options) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: options.method,
      headers: options.headers
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.write(options.body)
    req.end()
  })
}

module.exports = { removeWatermarkAliyun, removeWatermarkAndSave }
