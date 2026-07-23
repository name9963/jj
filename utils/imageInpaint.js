// server/utils/imageInpaint.js
// 图片去水印模块 - 基于 OpenCV 风格的 inpainting 算法
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

/**
 * 图片去水印主函数
 * 使用基于邻域像素插值的 inpainting 算法消除涂抹区域
 * @param {string} imagePath - 原图路径
 * @param {string} maskPath - 遮罩图路径（红色涂抹区域为待处理区域）
 * @returns {Promise<string>} 处理后图片路径
 */
async function removeWatermark(imagePath, maskPath) {
  // 读取原图和遮罩
  const image = sharp(imagePath)
  const imageMeta = await image.metadata()
  const { width, height } = imageMeta

  // 获取原始像素数据 (RGBA)
  const imageBuffer = await image
    .ensureAlpha()
    .raw()
    .toBuffer()

  // 获取遮罩像素数据
  const maskBuffer = await sharp(maskPath)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer()

  // 生成二值遮罩：红色通道高且透明度>0的区域为需要修复的区域
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = maskBuffer[i * 4]
    const g = maskBuffer[i * 4 + 1]
    const b = maskBuffer[i * 4 + 2]
    const a = maskBuffer[i * 4 + 3]
    // 涂抹颜色为 rgba(255, 80, 80, 0.5)，红色通道明显高于其他
    if (a > 20 && r > 100 && r > g * 1.5 && r > b * 1.5) {
      mask[i] = 1
    }
  }

  // 执行 inpainting
  const result = inpaint(imageBuffer, mask, width, height)

  // 输出结果图片
  const outputDir = path.join(__dirname, '..', 'uploads')
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  const outputPath = path.join(outputDir, `result_${Date.now()}.png`)

  await sharp(result, {
    raw: { width, height, channels: 4 }
  })
    .png()
    .toFile(outputPath)

  return outputPath
}

/**
 * Inpainting 算法实现
 * 使用多轮迭代扩散填充：从遮罩边缘向内逐层填充像素
 */
function inpaint(imageBuffer, mask, width, height) {
  const result = Buffer.from(imageBuffer)
  const channels = 4
  const totalPixels = width * height

  // 计算每个遮罩像素到边缘的距离（用于确定填充顺序）
  const dist = computeDistance(mask, width, height)

  // 找到最大距离
  let maxDist = 0
  for (let i = 0; i < totalPixels; i++) {
    if (dist[i] > maxDist) maxDist = dist[i]
  }

  // 从边缘向内逐层填充
  for (let d = 1; d <= maxDist; d++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x
        if (mask[idx] !== 1 || dist[idx] !== d) continue

        // 收集周围已填充的像素（距离 < d 的邻居）
        let rSum = 0, gSum = 0, bSum = 0, aSum = 0, count = 0
        const radius = 2

        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue

            const nIdx = ny * width + nx
            // 只使用非遮罩区域或已填充的像素
            if (mask[nIdx] === 0 || dist[nIdx] < d) {
              const offset = nIdx * channels
              const weight = 1 / (Math.abs(dx) + Math.abs(dy) + 1)
              rSum += result[offset] * weight
              gSum += result[offset + 1] * weight
              bSum += result[offset + 2] * weight
              aSum += result[offset + 3] * weight
              count += weight
            }
          }
        }

        if (count > 0) {
          const offset = idx * channels
          result[offset] = Math.round(rSum / count)
          result[offset + 1] = Math.round(gSum / count)
          result[offset + 2] = Math.round(bSum / count)
          result[offset + 3] = Math.round(aSum / count)
        }
      }
    }
  }

  // 对修复区域做轻微高斯模糊使过渡更自然
  smoothRegion(result, mask, dist, width, height)

  return result
}

/**
 * 计算遮罩内每个像素到边缘的距离（BFS）
 */
function computeDistance(mask, width, height) {
  const totalPixels = width * height
  const dist = new Int32Array(totalPixels).fill(-1)
  const queue = []

  // 找到遮罩边缘像素（与背景相邻的遮罩像素）
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (mask[idx] !== 1) {
        dist[idx] = 0
        continue
      }

      // 检查四邻域是否有背景像素
      const neighbors = [
        [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]
      ]
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || mask[ny * width + nx] === 0) {
          dist[idx] = 1
          queue.push(idx)
          break
        }
      }
    }
  }

  // BFS 扩散
  let head = 0
  while (head < queue.length) {
    const idx = queue[head++]
    const x = idx % width
    const y = Math.floor(idx / width)
    const neighbors = [
      [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]
    ]

    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
      const nIdx = ny * width + nx
      if (mask[nIdx] === 1 && dist[nIdx] === -1) {
        dist[nIdx] = dist[idx] + 1
        queue.push(nIdx)
      }
    }
  }

  // 未到达的像素设为最大距离
  for (let i = 0; i < totalPixels; i++) {
    if (dist[i] === -1) dist[i] = 9999
  }

  return dist
}

/**
 * 对修复区域做平滑处理
 */
function smoothRegion(buffer, mask, dist, width, height) {
  const channels = 4
  const copy = Buffer.from(buffer)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (mask[idx] !== 1) continue

      const offset = idx * channels
      for (let c = 0; c < channels; c++) {
        // 3x3 均值滤波
        let sum = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nIdx = (y + dy) * width + (x + dx)
            sum += copy[nIdx * channels + c]
          }
        }
        buffer[offset + c] = Math.round(sum / 9)
      }
    }
  }
}

module.exports = { removeWatermark }
