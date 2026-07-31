// server/utils/cloudStorage.js
// 微信云存储读写（B+ 方案）：借助微信云托管「开放接口服务」，
// 容器内免鉴权调用 http://api.weixin.qq.com/tcb/* 接口，无需维护 access_token。
// 依赖控制台已开启「开放接口服务」并配置 /tcb/uploadfile、/tcb/batchdownloadfile。
const axios = require('axios')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ENV = process.env.CLOUD_ENV || 'prod-d9g0j6z6hea161a52'
// 免鉴权内网地址：微信云托管开放接口服务代理，无需 access_token
const OPENAPI_BASE = 'http://api.weixin.qq.com'

/**
 * 判断是否云存储 fileID
 */
function isCloudFileID(s) {
  return typeof s === 'string' && /^cloud:\/\//i.test(s)
}

/**
 * 下载云存储文件到本地临时文件。
 * @param {string} fileID cloud:// 开头
 * @returns {Promise<string>} 本地临时文件路径（调用方负责删除）
 */
async function downloadCloudFile(fileID) {
  // 1) 换取临时下载地址
  const { data } = await axios.post(
    `${OPENAPI_BASE}/tcb/batchdownloadfile`,
    { env: ENV, file_list: [{ fileid: fileID, max_age: 7200 }] },
    { timeout: 20000 }
  )
  if (data.errcode || !data.file_list || !data.file_list[0] || !data.file_list[0].download_url) {
    throw new Error(`云存储下载地址获取失败: ${data.errmsg || JSON.stringify(data)}`)
  }
  const downloadUrl = data.file_list[0].download_url

  // 2) 下载内容到本地临时文件
  const ext = path.extname(fileID.split('?')[0]) || '.dat'
  const dest = path.join(os.tmpdir(), `cf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`)
  const resp = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 60 * 1024 * 1024 })
  fs.writeFileSync(dest, Buffer.from(resp.data))
  return dest
}

/**
 * 上传本地文件到云存储，返回 fileID。
 * @param {string} localPath 本地文件路径
 * @param {string} cloudPath 云存储目标路径（如 results/xxx.png）
 * @returns {Promise<string>} cloud:// fileID
 */
async function uploadCloudFile(localPath, cloudPath) {
  // 1) 申请上传链接
  const { data } = await axios.post(
    `${OPENAPI_BASE}/tcb/uploadfile`,
    { env: ENV, path: cloudPath },
    { timeout: 20000 }
  )
  if (data.errcode || !data.url) {
    throw new Error(`云存储上传链接获取失败: ${data.errmsg || JSON.stringify(data)}`)
  }

  // 2) 按返回的鉴权信息 POST 到 COS
  const FormData = require('form-data')
  const form = new FormData()
  form.append('key', cloudPath)
  form.append('Signature', data.authorization)
  form.append('x-cos-security-token', data.token)
  form.append('x-cos-meta-fileid', data.cos_file_id)
  form.append('file', fs.createReadStream(localPath))

  const uploadResp = await axios.post(data.url, form, {
    headers: form.getHeaders(),
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: (s) => s >= 200 && s < 300
  })
  if (uploadResp.status < 200 || uploadResp.status >= 300) {
    throw new Error(`云存储上传失败: HTTP ${uploadResp.status}`)
  }

  return data.file_id
}

module.exports = { isCloudFileID, downloadCloudFile, uploadCloudFile, ENV }
