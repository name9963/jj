// server/utils/imageInpaint.js
// 图片去水印模块 - 快速纹理修复版
// 策略：快速扩散填充 + 边界纹理块精修（兼顾速度和质量）
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

async function removeWatermark(imagePath, maskPath) {
  const image = sharp(imagePath)
  const imageMeta = await image.metadata()
  const { width, height } = imageMeta

  const imageBuffer = await image.ensureAlpha().raw().toBuffer()

  const maskBuffer = await sharp(maskPath)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer()

  const mask = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = maskBuffer[i * 4]
    const g = maskBuffer[i * 4 + 1]
    const b = maskBuffer[i * 4 + 2]
    const a = maskBuffer[i * 4 + 3]
    if (a > 20 && r > 100 && r > g * 1.5 && r > b * 1.5) {
      mask[i] = 1
    }
  }

  const expandedMask = expandMask(mask, width, height, 1)
  const result = inpaint(imageBuffer, expandedMask, width, height)

  const outputDir = path.join(__dirname, '..', 'uploads')
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  const outputPath = path.join(outputDir, `result_${Date.now()}.png`)

  await sharp(result, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(outputPath)

  return outputPath
}

function expandMask(mask, width, height, radius) {
  const expanded = new Uint8Array(mask)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              expanded[ny * width + nx] = 1
            }
          }
        }
      }
    }
  }
  return expanded
}

function inpaint(imageBuffer, mask, width, height) {
  const result = Buffer.from(imageBuffer)
  const channels = 4
  const totalPixels = width * height

  const dist = computeDistance(mask, width, height)
  let maxDist = 0
  for (let i = 0; i < totalPixels; i++) {
    if (dist[i] > maxDist) maxDist = dist[i]
  }

  // === 阶段1：快速扩散填充（大半径高斯加权）===
  const fillRadius = Math.min(12, Math.max(5, maxDist))

  for (let d = 1; d <= maxDist; d++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x
        if (mask[idx] !== 1 || dist[idx] !== d) continue

        let rSum = 0, gSum = 0, bSum = 0, aSum = 0, wSum = 0

        for (let dy = -fillRadius; dy <= fillRadius; dy += 1) {
          for (let dx = -fillRadius; dx <= fillRadius; dx += 1) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
            const nIdx = ny * width + nx
            if (mask[nIdx] === 0 || dist[nIdx] < d) {
              const offset = nIdx * channels
              const spatialDist2 = dx * dx + dy * dy
              const w = Math.exp(-spatialDist2 / (2 * (fillRadius / 2) * (fillRadius / 2)))
              rSum += result[offset] * w
              gSum += result[offset + 1] * w
              bSum += result[offset + 2] * w
              aSum += result[offset + 3] * w
              wSum += w
            }
          }
        }

        if (wSum > 0) {
          const offset = idx * channels
          result[offset] = Math.round(rSum / wSum)
          result[offset + 1] = Math.round(gSum / wSum)
          result[offset + 2] = Math.round(bSum / wSum)
          result[offset + 3] = Math.round(aSum / wSum)
        }
      }
    }
  }

  // === 阶段2：边界纹理块精修（只处理边缘几层，速度快）===
  const PATCH = 5
  const SEARCH_R = 30
  const BLEND_LAYERS = Math.min(4, maxDist)

  for (let y = PATCH; y < height - PATCH; y++) {
    for (let x = PATCH; x < width - PATCH; x++) {
      const idx = y * width + x
      if (mask[idx] !== 1 || dist[idx] > BLEND_LAYERS) continue

      // 在周围已知区域找最佳匹配块
      const best = findBestPatchFast(result, mask, x, y, width, height, channels, PATCH, SEARCH_R)
      if (best) {
        const offset = idx * channels
        // 混合：靠近边缘更多使用纹理块，内部更多使用扩散结果
        const t = dist[idx] / (BLEND_LAYERS + 1)
        const alpha = (1 - t) * 0.6
        result[offset] = Math.round(result[offset] * (1 - alpha) + best[0] * alpha)
        result[offset + 1] = Math.round(result[offset + 1] * (1 - alpha) + best[1] * alpha)
        result[offset + 2] = Math.round(result[offset + 2] * (1 - alpha) + best[2] * alpha)
      }
    }
  }

  // === 阶段3：整体轻微平滑（消除接缝）===
  lightSmooth(result, mask, width, height, channels)

  return result
}

/**
 * 快速纹理块匹配：只在已知像素中搜索，步长为2加速
 */
function findBestPatchFast(buffer, mask, tx, ty, width, height, channels, patchSize, searchRadius) {
  let bestSSD = Infinity
  let bestColor = null
  const half = Math.floor(patchSize / 2)

  const startX = Math.max(half, tx - searchRadius)
  const endX = Math.min(width - half - 1, tx + searchRadius)
  const startY = Math.max(half, ty - searchRadius)
  const endY = Math.min(height - half - 1, ty + searchRadius)

  for (let sy = startY; sy <= endY; sy += 2) {
    for (let sx = startX; sx <= endX; sx += 2) {
      const sIdx = sy * width + sx
      if (mask[sIdx] === 1) continue

      // 快速 SSD：只比较中心十字采样（5个点）
      let ssd = 0
      let valid = true
      const offsets = [[0,0],[-half,0],[half,0],[0,-half],[0,half]]

      for (const [dx, dy] of offsets) {
        const snx = sx + dx, sny = sy + dy
        const tnx = tx + dx, tny = ty + dy
        if (snx < 0 || snx >= width || sny < 0 || sny >= height) { valid = false; break }
        if (tnx < 0 || tnx >= width || tny < 0 || tny >= height) continue
        const sNIdx = sny * width + snx
        if (mask[sNIdx] === 1) { valid = false; break }

        const sOff = sNIdx * channels
        const tOff = (tny * width + tnx) * channels
        const dr = buffer[sOff] - buffer[tOff]
        const dg = buffer[sOff + 1] - buffer[tOff + 1]
        const db = buffer[sOff + 2] - buffer[tOff + 2]
        ssd += dr * dr + dg * dg + db * db
      }

      if (valid && ssd < bestSSD) {
        bestSSD = ssd
        const sOff = sIdx * channels
        bestColor = [buffer[sOff], buffer[sOff + 1], buffer[sOff + 2], buffer[sOff + 3]]
      }
    }
  }

  return bestColor
}

/**
 * 轻微平滑：只对遮罩区域做 3x3 均值，消除块效应
 */
function lightSmooth(buffer, mask, width, height, channels) {
  const copy = Buffer.from(buffer)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (mask[idx] !== 1) continue
      const offset = idx * channels
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += copy[((y + dy) * width + (x + dx)) * channels + c]
          }
        }
        // 70% 原值 + 30% 均值（轻微平滑）
        buffer[offset + c] = Math.round(copy[offset + c] * 0.7 + (sum / 9) * 0.3)
      }
    }
  }
}

function computeDistance(mask, width, height) {
  const totalPixels = width * height
  const dist = new Int32Array(totalPixels).fill(-1)
  const queue = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (mask[idx] !== 1) { dist[idx] = 0; continue }
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || mask[ny * width + nx] === 0) {
          dist[idx] = 1
          queue.push(idx)
          break
        }
      }
    }
  }

  let head = 0
  while (head < queue.length) {
    const idx = queue[head++]
    const x = idx % width, y = Math.floor(idx / width)
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
      const nIdx = ny * width + nx
      if (mask[nIdx] === 1 && dist[nIdx] === -1) {
        dist[nIdx] = dist[idx] + 1
        queue.push(nIdx)
      }
    }
  }

  for (let i = 0; i < totalPixels; i++) {
    if (dist[i] === -1) dist[i] = 9999
  }
  return dist
}

module.exports = { removeWatermark }
