// server/utils/lamaInpaint.js
// LaMa (Resolution-robust Large Mask Inpainting, Apache-2.0) AI 修复模型
// 本地 ONNX 推理，无需网络/无按次收费，语义理解修复，效果显著优于样本块拼接
// 模型来源: https://github.com/opencv/opencv_zoo/tree/main/models/inpainting_lama
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

// 防御性加载：onnxruntime-node 是原生二进制(仅支持 glibc)，
// 平台不兼容时 require 会直接抛错；绝不能因此拖崩整个服务，
// 加载失败则禁用本地 AI 修复，上层自动回退传统算法。
let ort = null
try {
  ort = require('onnxruntime-node')
} catch (err) {
  console.error('[LaMa] onnxruntime-node 加载失败，本地AI修复不可用:', err.message)
}

const MODEL_PATH = path.join(__dirname, '..', 'models', 'lama.onnx')
const MODEL_SIZE = 512 // 模型固定输入/输出尺寸

// 模型文件存在且大小合理才算有效（构建时下载失败会留空文件占位）
function modelFileValid() {
  try {
    return fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size > 10 * 1024 * 1024
  } catch {
    return false
  }
}

let sessionPromise = null
function getSession() {
  if (!sessionPromise) {
    const disabled = process.env.DISABLE_LOCAL_LAMA === '1'
    if (disabled) {
      console.log('[LaMa] 已通过 DISABLE_LOCAL_LAMA 禁用本地 ONNX 推理')
    }
    sessionPromise = (!disabled && ort && modelFileValid())
      ? ort.InferenceSession.create(MODEL_PATH).catch(err => {
          console.error('[LaMa] 模型加载失败:', err.message)
          return null
        })
      : Promise.resolve(null)
  }
  return sessionPromise
}

/** 模型文件是否存在、是否加载成功。供健康检查/日志使用 */
async function isAvailable() {
  return (await getSession()) !== null
}

/**
 * 用 LaMa 模型修复 hole 区域。
 * 只裁剪 hole 周围一块区域喂给模型（而不是整图挤压成512x512)，
 * 保留 hole 附近的分辨率细节，裁剪范围外的原图内容完全不受影响。
 * @param buffer RGBA raw Buffer，就地写回 hole 部分的修复结果
 * @param hole Uint8Array 长度 width*height，1=待修复
 * @returns {Promise<boolean>} true=修复成功已写回；false=模型不可用或推理失败，上层应回退到本地算法
 */
async function lamaInpaint(buffer, hole, width, height) {
  const session = await getSession()
  if (!session) return false

  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (hole[y * width + x] === 1) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return true // 无 hole，无需处理

  // 裁剪范围：hole 尺寸的 0.6 倍或至少 80px 作为上下文边距，
  // 给模型足够的背景参考，又不至于把 hole 之外太多内容一起挤压变形
  const holeW = maxX - minX + 1, holeH = maxY - minY + 1
  const margin = Math.max(80, Math.round(Math.max(holeW, holeH) * 0.6))
  const cx0 = Math.max(0, minX - margin)
  const cy0 = Math.max(0, minY - margin)
  const cx1 = Math.min(width - 1, maxX + margin)
  const cy1 = Math.min(height - 1, maxY + margin)
  const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1

  try {
    const maskRaw = Buffer.alloc(width * height)
    for (let i = 0; i < width * height; i++) maskRaw[i] = hole[i] ? 255 : 0

    const [imgCrop, maskCrop] = await Promise.all([
      sharp(buffer, { raw: { width, height, channels: 4 } })
        .extract({ left: cx0, top: cy0, width: cw, height: ch })
        .removeAlpha()
        .resize(MODEL_SIZE, MODEL_SIZE, { fit: 'fill' })
        .raw()
        .toBuffer(),
      sharp(maskRaw, { raw: { width, height, channels: 1 } })
        .extract({ left: cx0, top: cy0, width: cw, height: ch })
        .resize(MODEL_SIZE, MODEL_SIZE, { fit: 'fill', kernel: 'nearest' })
        .raw()
        .toBuffer()
    ])

    const HW = MODEL_SIZE * MODEL_SIZE
    const imgTensorData = new Float32Array(3 * HW)
    for (let i = 0; i < HW; i++) {
      const off = i * 3
      imgTensorData[i] = imgCrop[off] / 255
      imgTensorData[HW + i] = imgCrop[off + 1] / 255
      imgTensorData[2 * HW + i] = imgCrop[off + 2] / 255
    }
    const maskTensorData = new Float32Array(HW)
    for (let i = 0; i < HW; i++) maskTensorData[i] = maskCrop[i] > 127 ? 1 : 0

    const results = await session.run({
      image: new ort.Tensor('float32', imgTensorData, [1, 3, MODEL_SIZE, MODEL_SIZE]),
      mask: new ort.Tensor('float32', maskTensorData, [1, 1, MODEL_SIZE, MODEL_SIZE])
    })

    const outData = results[session.outputNames[0]].data // 已确认输出即 0-255 范围
    const outRgb = Buffer.alloc(HW * 3)
    for (let i = 0; i < HW; i++) {
      outRgb[i * 3] = clampByte(outData[i])
      outRgb[i * 3 + 1] = clampByte(outData[HW + i])
      outRgb[i * 3 + 2] = clampByte(outData[2 * HW + i])
    }

    const outResized = await sharp(outRgb, { raw: { width: MODEL_SIZE, height: MODEL_SIZE, channels: 3 } })
      .resize(cw, ch, { fit: 'fill' })
      .raw()
      .toBuffer()

    // 只把 hole 范围内的像素写回原图，裁剪区域内的非 hole 像素保持原样
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const gIdx = (cy0 + y) * width + (cx0 + x)
        if (hole[gIdx] !== 1) continue
        const srcOff = (y * cw + x) * 3
        const dstOff = gIdx * 4
        buffer[dstOff] = outResized[srcOff]
        buffer[dstOff + 1] = outResized[srcOff + 1]
        buffer[dstOff + 2] = outResized[srcOff + 2]
      }
    }
    return true
  } catch (err) {
    console.error('[LaMa] 推理失败，回退本地算法:', err.message)
    return false
  }
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

module.exports = { lamaInpaint, isAvailable }
