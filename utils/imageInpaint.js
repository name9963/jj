// server/utils/imageInpaint.js
// 图片去水印模块 - 优化版 inpainting 算法
// 改进：高斯加权采样、边缘感知、多轮迭代精化、边界梯度匹配、纹理噪声注入
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

/**
 * 图片去水印主函数
 * @param {string} imagePath - 原图路径
 * @param {string} maskPath - 遮罩图路径（红色涂抹区域为待处理区域）
 * @returns {Promise<string>} 处理后图片路径
 */
async function removeWatermark(imagePath, maskPath) {
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

  // 生成二值遮罩
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

  // 扩展遮罩边缘 1-2px，确保水印边缘也被覆盖
  const expandedMask = expandMask(mask, width, height, 2)

  // 执行优化版 inpainting
  const result = inpaint(imageBuffer, expandedMask, width, height)

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
 * 扩展遮罩边缘，确保水印抗锯齿边缘也被处理
 */
function expandMask(mask, width, height, radius) {
  const expanded = new Uint8Array(mask)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (mask[idx] === 1) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx
            const ny = y + dy
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

/**
 * 优化版 Inpainting 算法
 * 1. 从边缘向内逐层高斯加权填充
 * 2. 多轮迭代精化
 * 3. 边界梯度匹配
 * 4. 边缘感知平滑（双边滤波）
 * 5. 纹理噪声注入
 */
function inpaint(imageBuffer, mask, width, height) {
  const result = Buffer.from(imageBuffer)
  const channels = 4
  const totalPixels = width * height

  // 计算距离图
  const dist = computeDistance(mask, width, height)

  let maxDist = 0
  for (let i = 0; i < totalPixels; i++) {
    if (dist[i] > maxDist) maxDist = dist[i]
  }

  // === 第一阶段：高斯加权逐层填充 ===
  const sampleRadius = Math.min(8, Math.max(4, Math.floor(maxDist / 2)))

  for (let d = 1; d <= maxDist; d++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x
        if (mask[idx] !== 1 || dist[idx] !== d) continue

        let rSum = 0, gSum = 0, bSum = 0, aSum = 0, wSum = 0

        for (let dy = -sampleRadius; dy <= sampleRadius; dy++) {
          for (let dx = -sampleRadius; dx <= sampleRadius; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue

            const nIdx = ny * width + nx
            if (mask[nIdx] === 0 || dist[nIdx] < d) {
              const offset = nIdx * channels
              // 高斯距离衰减 + 方向一致性加权
              const spatialDist = Math.sqrt(dx * dx + dy * dy)
              const gaussWeight = Math.exp(-(spatialDist * spatialDist) / (2 * (sampleRadius / 2) * (sampleRadius / 2)))
              // 越靠近边缘的已知像素权重越高
              const reliability = mask[nIdx] === 0 ? 1.0 : 0.7
              const weight = gaussWeight * reliability

              rSum += result[offset] * weight
              gSum += result[offset + 1] * weight
              bSum += result[offset + 2] * weight
              aSum += result[offset + 3] * weight
              wSum += weight
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

  // === 第二阶段：多轮迭代精化（让内部像素参考更多已填充信息）===
  for (let iter = 0; iter < 3; iter++) {
    refinePass(result, mask, dist, width, height, sampleRadius)
  }

  // === 第三阶段：边界梯度匹配 ===
  matchBoundaryGradient(result, mask, dist, width, height)

  // === 第四阶段：边缘感知平滑（双边滤波）===
  bilateralSmooth(result, mask, width, height)

  // === 第五阶段：纹理噪声注入（避免塑料感）===
  injectTextureNoise(result, mask, imageBuffer, width, height)

  return result
}

/**
 * 迭代精化：对遮罩区域重新采样，使用更大的参考范围
 */
function refinePass(buffer, mask, dist, width, height, radius) {
  const channels = 4
  const copy = Buffer.from(buffer)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (mask[idx] !== 1) continue

      let rSum = 0, gSum = 0, bSum = 0, aSum = 0, wSum = 0

      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue

          const nIdx = ny * width + nx
          const offset = nIdx * channels
          const spatialDist = Math.sqrt(dx * dx + dy * dy)
          if (spatialDist > radius) continue

          const gaussWeight = Math.exp(-(spatialDist * spatialDist) / (2 * (radius / 2.5) * (radius / 2.5)))
          // 非遮罩像素权重更高
          const reliability = mask[nIdx] === 0 ? 1.5 : 1.0
          const weight = gaussWeight * reliability

          rSum += copy[offset] * weight
          gSum += copy[offset + 1] * weight
          bSum += copy[offset + 2] * weight
          aSum += copy[offset + 3] * weight
          wSum += weight
        }
      }

      if (wSum > 0) {
        const offset = idx * channels
        // 混合原始填充和精化结果（70%精化 + 30%原始）
        buffer[offset] = Math.round(result_blend(buffer[offset], rSum / wSum, 0.7))
        buffer[offset + 1] = Math.round(result_blend(buffer[offset + 1], gSum / wSum, 0.7))
        buffer[offset + 2] = Math.round(result_blend(buffer[offset + 2], bSum / wSum, 0.7))
        buffer[offset + 3] = Math.round(result_blend(buffer[offset + 3], aSum / wSum, 0.7))
      }
    }
  }
}

function result_blend(original, refined, ratio) {
  return original * (1 - ratio) + refined * ratio
}

/**
 * 边界梯度匹配：让遮罩边缘的过渡更自然
 * 在遮罩边界内外各取一圈像素，匹配梯度方向
 */
function matchBoundaryGradient(buffer, mask, dist, width, height) {
  const channels = 4
  const blendWidth = 3 // 边界混合宽度

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (mask[idx] !== 1) continue
      if (dist[idx] > blendWidth) continue

      // 计算该像素与外部已知区域的梯度差
      const offset = idx * channels
      const t = dist[idx] / (blendWidth + 1) // 0~1 的混合因子

      // 获取外部参考像素的平均值
      let extR = 0, extG = 0, extB = 0, extCount = 0
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const nIdx = ny * width + nx
          if (mask[nIdx] === 0) {
            const nOff = nIdx * channels
            extR += buffer[nOff]
            extG += buffer[nOff + 1]
            extB += buffer[nOff + 2]
            extCount++
          }
        }
      }

      if (extCount > 0) {
        extR /= extCount
        extG /= extCount
        extB /= extCount
        // 靠近边界的像素更多参考外部值
        const alpha = (1 - t) * 0.4
        buffer[offset] = Math.round(buffer[offset] * (1 - alpha) + extR * alpha)
        buffer[offset + 1] = Math.round(buffer[offset + 1] * (1 - alpha) + extG * alpha)
        buffer[offset + 2] = Math.round(buffer[offset + 2] * (1 - alpha) + extB * alpha)
      }
    }
  }
}

/**
 * 双边滤波平滑：保边去噪
 * 同时考虑空间距离和颜色相似度
 */
function bilateralSmooth(buffer, mask, width, height) {
  const channels = 4
  const copy = Buffer.from(buffer)
  const sigmaSpace = 3
  const sigmaColor = 25

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (mask[idx] !== 1) continue

      const offset = idx * channels
      const centerR = copy[offset]
      const centerG = copy[offset + 1]
      const centerB = copy[offset + 2]

      let rSum = 0, gSum = 0, bSum = 0, wSum = 0

      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue

          const nIdx = ny * width + nx
          const nOff = nIdx * channels

          const spatialDist = dx * dx + dy * dy
          const colorDist =
            (copy[nOff] - centerR) ** 2 +
            (copy[nOff + 1] - centerG) ** 2 +
            (copy[nOff + 2] - centerB) ** 2

          const spatialWeight = Math.exp(-spatialDist / (2 * sigmaSpace * sigmaSpace))
          const colorWeight = Math.exp(-colorDist / (2 * sigmaColor * sigmaColor))
          const weight = spatialWeight * colorWeight

          rSum += copy[nOff] * weight
          gSum += copy[nOff + 1] * weight
          bSum += copy[nOff + 2] * weight
          wSum += weight
        }
      }

      if (wSum > 0) {
        buffer[offset] = Math.round(rSum / wSum)
        buffer[offset + 1] = Math.round(gSum / wSum)
        buffer[offset + 2] = Math.round(bSum / wSum)
      }
    }
  }
}

/**
 * 纹理噪声注入：从原图非遮罩区域采样纹理特征，注入到修复区域
 * 避免大面积修复后出现"塑料感"
 */
function injectTextureNoise(buffer, mask, originalBuffer, width, height) {
  const channels = 4

  // 计算原图非遮罩区域的局部方差（纹理强度）
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const idx = y * width + x
      if (mask[idx] !== 1) continue

      const offset = idx * channels

      // 从附近非遮罩区域采样纹理噪声
      let noiseR = 0, noiseG = 0, noiseB = 0, sampleCount = 0
      const searchRadius = 12

      for (let s = 0; s < 8; s++) {
        // 随机方向采样
        const angle = (s / 8) * Math.PI * 2
        const dist = searchRadius * (0.5 + Math.random() * 0.5)
        const sx = Math.round(x + Math.cos(angle) * dist)
        const sy = Math.round(y + Math.sin(angle) * dist)

        if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
          const sIdx = sy * width + sx
          if (mask[sIdx] === 0) {
            const sOff = sIdx * channels
            // 计算局部梯度作为纹理参考
            if (sx > 0 && sx < width - 1) {
              const leftOff = (sIdx - 1) * channels
              const rightOff = (sIdx + 1) * channels
              noiseR += (originalBuffer[rightOff] - originalBuffer[leftOff])
              noiseG += (originalBuffer[rightOff + 1] - originalBuffer[leftOff + 1])
              noiseB += (originalBuffer[rightOff + 2] - originalBuffer[leftOff + 2])
              sampleCount++
            }
          }
        }
      }

      if (sampleCount > 0) {
        // 注入微弱的纹理噪声（强度为采样梯度的 15%）
        const strength = 0.15
        buffer[offset] = clamp(buffer[offset] + (noiseR / sampleCount) * strength)
        buffer[offset + 1] = clamp(buffer[offset + 1] + (noiseG / sampleCount) * strength)
        buffer[offset + 2] = clamp(buffer[offset + 2] + (noiseB / sampleCount) * strength)
      }
    }
  }
}

function clamp(val) {
  return Math.max(0, Math.min(255, Math.round(val)))
}

/**
 * 计算遮罩内每个像素到边缘的距离（BFS）
 */
function computeDistance(mask, width, height) {
  const totalPixels = width * height
  const dist = new Int32Array(totalPixels).fill(-1)
  const queue = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (mask[idx] !== 1) {
        dist[idx] = 0
        continue
      }

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

  for (let i = 0; i < totalPixels; i++) {
    if (dist[i] === -1) dist[i] = 9999
  }

  return dist
}

module.exports = { removeWatermark }
