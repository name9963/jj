// server/utils/imageInpaint.js
// 本地图片去水印 —— 样本块修复算法(Criminisi exemplar-based inpainting)
// 流程：解析涂抹遮罩 → 区域内检测文字/水印像素 → 膨胀 → 从周围复制真实纹理块填充 → 边界羽化
// 核心优势：保留纹理细节，无模糊马赛克；纹理背景效果显著优于平滑插值
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

// 检测参数
const BG_WINDOW = 7        // 背景色采样窗口半径
const MARK_THRESHOLD = 30  // 与背景色差(RGB 绝对差之和)超过此值判定为文字/水印
const MIN_BG_SAMPLES = 4   // 窗口内至少这么多背景像素才做文字判定，否则视为实心涂抹整块填充
const HOLE_DILATE = 2      // 挖除区域向外膨胀，吃掉文字抗锯齿边缘
const CROP_MARGIN = 40     // 填充时裁剪包围盒外扩，保证有足够背景参与

// 样本块修复(Criminisi exemplar-based inpainting)参数
const PATCH_RADIUS = 4       // 样本块半径，块边长 = 2*R+1 = 9，平衡纹理连贯性与性能
const SEARCH_RADIUS = 32     // 在待填点周围多大范围内搜索最佳匹配块，利用纹理空间局部性
const SEARCH_STEP = 1        // 搜索步长，1=精确 2=快速
const MAX_CANDIDATES = 1.5e7 // 候选块评估总预算，超出则剩余像素回退平滑填充
const ALPHA = 255            // 数据项归一化常数

async function removeWatermark(imagePath, maskPath) {
  const image = sharp(imagePath)
  const { width, height } = await image.metadata()

  const imageBuffer = await image.ensureAlpha().raw().toBuffer()
  const maskBuffer = await sharp(maskPath)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer()

  // 1. 解析用户涂抹范围
  const brush = parseBrushMask(maskBuffer, width, height)

  // 2. 涂抹范围内识别真正要去掉的像素（文字/水印）
  let hole = detectMarks(imageBuffer, brush, width, height)

  // 3. 膨胀，吃掉文字边缘的半透明像素
  hole = dilate(hole, width, height, HOLE_DILATE)

  // 4. 用周围颜色平滑填充
  fillSmooth(imageBuffer, hole, width, height)

  // 5. 边界轻微羽化，消除接缝
  featherBoundary(imageBuffer, hole, width, height)

  const outputDir = path.join(__dirname, '..', 'uploads')
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `result_${Date.now()}.png`)

  await sharp(imageBuffer, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(outputPath)

  return outputPath
}
/**
 * 解析涂抹遮罩：canvas 画笔是半透明红色 rgba(255,80,80,0.5)
 * 返回 Uint8Array，1 表示用户涂抹的范围
 */
function parseBrushMask(maskBuffer, width, height) {
  const brush = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = maskBuffer[i * 4]
    const g = maskBuffer[i * 4 + 1]
    const b = maskBuffer[i * 4 + 2]
    const a = maskBuffer[i * 4 + 3]
    // 红色占主导且有一定不透明度 = 用户涂抹处
    if (a > 20 && r > 100 && r > g * 1.5 && r > b * 1.5) {
      brush[i] = 1
    }
  }
  return brush
}

/**
 * 在涂抹范围内识别要挖除的像素
 * 原理：对每个涂抹像素，取周围窗口内"未涂抹"的像素估算局部背景色(中值)，
 *      当前像素与背景色差超过阈值 → 判定为文字/水印 → 标记为 hole。
 * 若窗口内几乎没有背景像素(说明是大片实心涂抹)，则整块标为 hole 直接填充。
 * 若整体检出的 hole 太少(低对比度水印检测失败)，回退为填充整个涂抹范围。
 */
function detectMarks(buffer, brush, width, height) {
  const hole = new Uint8Array(width * height)
  let brushCount = 0
  let markCount = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (brush[idx] !== 1) continue
      brushCount++

      const offset = idx * 4
      const rVals = [], gVals = [], bVals = []

      for (let dy = -BG_WINDOW; dy <= BG_WINDOW; dy++) {
        for (let dx = -BG_WINDOW; dx <= BG_WINDOW; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const nIdx = ny * width + nx
          if (brush[nIdx] === 0) {
            const nOff = nIdx * 4
            rVals.push(buffer[nOff])
            gVals.push(buffer[nOff + 1])
            bVals.push(buffer[nOff + 2])
          }
        }
      }

      // 周围没有足够背景像素 → 实心涂抹内部，直接挖除填充
      if (rVals.length < MIN_BG_SAMPLES) {
        hole[idx] = 1
        markCount++
        continue
      }

      const bgR = median(rVals), bgG = median(gVals), bgB = median(bVals)
      const diff = Math.abs(buffer[offset] - bgR) +
                   Math.abs(buffer[offset + 1] - bgG) +
                   Math.abs(buffer[offset + 2] - bgB)

      if (diff > MARK_THRESHOLD) {
        hole[idx] = 1
        markCount++
      }
    }
  }

  // 检出太少 → 检测失败，回退为填充整个涂抹范围
  if (brushCount > 0 && markCount < brushCount * 0.02) {
    return Uint8Array.from(brush)
  }
  return hole
}

function median(arr) {
  arr.sort((a, b) => a - b)
  return arr[arr.length >> 1]
}
/**
 * 形态学膨胀：把 hole 向外扩 radius 像素
 */
function dilate(mask, width, height, radius) {
  if (radius <= 0) return mask
  const out = new Uint8Array(mask)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            out[ny * width + nx] = 1
          }
        }
      }
    }
  }
  return out
}

/**
 * 填充 hole 区域。先裁剪到 hole 包围盒(外扩 CROP_MARGIN)，
 * 优先用样本块修复(exemplar)从周围复制真实纹理块，保留细节；
 * 若 exemplar 因预算或缺少源像素未能填完，剩余部分回退 push-pull 平滑填充兜底。
 */
function fillSmooth(buffer, hole, width, height) {
  // 求包围盒
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
  if (maxX < 0) return // 无 hole

  minX = Math.max(0, minX - CROP_MARGIN)
  minY = Math.max(0, minY - CROP_MARGIN)
  maxX = Math.min(width - 1, maxX + CROP_MARGIN)
  maxY = Math.min(height - 1, maxY + CROP_MARGIN)

  const cw = maxX - minX + 1
  const ch = maxY - minY + 1

  // 提取子区域颜色 + 已填标记(filled=1 已知，0 为待填 hole)
  const color = new Float32Array(cw * ch * 3)
  const filled = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const srcIdx = (y + minY) * width + (x + minX)
      const dstIdx = y * cw + x
      const sOff = srcIdx * 4
      color[dstIdx * 3] = buffer[sOff]
      color[dstIdx * 3 + 1] = buffer[sOff + 1]
      color[dstIdx * 3 + 2] = buffer[sOff + 2]
      filled[dstIdx] = hole[srcIdx] === 1 ? 0 : 1
    }
  }

  // 1) 样本块修复：从周围复制真实纹理块（保留细节）
  exemplarInpaint(color, filled, cw, ch)

  // 2) exemplar 未填完的剩余像素 → push-pull 平滑兜底
  let anyUnfilled = false
  for (let i = 0; i < cw * ch; i++) {
    if (filled[i] === 0) { anyUnfilled = true; break }
  }
  if (anyUnfilled) {
    const weight = new Float32Array(cw * ch)
    for (let i = 0; i < cw * ch; i++) weight[i] = filled[i]
    const smooth = pushPull(color, weight, cw, ch)
    for (let i = 0; i < cw * ch; i++) {
      if (filled[i] === 0) {
        color[i * 3] = smooth[i * 3]
        color[i * 3 + 1] = smooth[i * 3 + 1]
        color[i * 3 + 2] = smooth[i * 3 + 2]
      }
    }
  }

  // 只写回 hole 像素
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const srcIdx = (y + minY) * width + (x + minX)
      if (hole[srcIdx] !== 1) continue
      const dstIdx = y * cw + x
      const sOff = srcIdx * 4
      buffer[sOff] = clamp(color[dstIdx * 3])
      buffer[sOff + 1] = clamp(color[dstIdx * 3 + 1])
      buffer[sOff + 2] = clamp(color[dstIdx * 3 + 2])
    }
  }
}

/**
 * 样本块修复(Criminisi exemplar-based inpainting)。
 * 在裁剪出的子区域上，从已知区域反复复制"最匹配的真实纹理块"填入 hole，
 * 按优先级(置信度×结构强度)从边界向内推进，保留边缘与纹理，无模糊马赛克。
 * @param color Float32Array 长度 w*h*3，就地修改
 * @param filled Uint8Array 长度 w*h，1=已知/已填 0=待填；就地修改
 * @returns 是否全部填完(false 表示预算耗尽，仍有 filled=0 待兜底)
 */
function exemplarInpaint(color, filled, w, h) {
  const n = w * h
  const conf = new Float32Array(n)          // 置信度：已知=1，hole=0
  for (let i = 0; i < n; i++) conf[i] = filled[i]

  const gray = new Float32Array(n)          // 灰度图，用于结构梯度(isophote)
  for (let i = 0; i < n; i++) {
    gray[i] = 0.299 * color[i * 3] + 0.587 * color[i * 3 + 1] + 0.114 * color[i * 3 + 2]
  }

  // 初始化填充前沿：待填且至少一个已填邻居
  let front = []
  const onFront = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (filled[idx] === 0 && hasFilledNeighbor(filled, x, y, w, h)) {
        front.push(idx); onFront[idx] = 1
      }
    }
  }

  let candidateBudget = MAX_CANDIDATES
  const justFilled = []

  while (front.length > 0) {
    // 1) 选出优先级最高的前沿点，同时剔除已被填的旧前沿
    let bestP = -1, bestIdx = -1, bestConf = 0
    const nextFront = []
    for (let k = 0; k < front.length; k++) {
      const idx = front[k]
      if (filled[idx] === 1) { onFront[idx] = 0; continue }
      nextFront.push(idx)
      const x = idx % w, y = (idx / w) | 0
      const c = patchConfidence(conf, filled, x, y, w, h)
      const p = c * dataTerm(gray, filled, x, y, w, h)
      if (p > bestP) { bestP = p; bestIdx = idx; bestConf = c }
    }
    front = nextFront
    if (bestIdx < 0) break

    // 2) 为该点在周围搜索最匹配的完整纹理块
    const tx = bestIdx % w, ty = (bestIdx / w) | 0
    const src = findBestPatch(color, filled, gray, tx, ty, w, h)
    candidateBudget -= src.evaluated

    // 3) 复制源块到 hole，更新颜色/灰度/置信度/前沿
    justFilled.length = 0
    copyPatch(color, filled, gray, conf, tx, ty, src.sx, src.sy, bestConf, w, h, justFilled)
    for (let j = 0; j < justFilled.length; j++) {
      addNeighborsToFront(filled, onFront, front, justFilled[j], w, h)
    }

    if (candidateBudget <= 0) break  // 预算耗尽，剩余交给 push-pull 兜底
  }

  for (let i = 0; i < n; i++) if (filled[i] === 0) return false
  return true
}

/** 是否有已填邻居(4 邻域) */
function hasFilledNeighbor(filled, x, y, w, h) {
  if (x > 0 && filled[y * w + x - 1]) return true
  if (x < w - 1 && filled[y * w + x + 1]) return true
  if (y > 0 && filled[(y - 1) * w + x]) return true
  if (y < h - 1 && filled[(y + 1) * w + x]) return true
  return false
}

/** 把某点尚未入列的待填邻居加入前沿 */
function addNeighborsToFront(filled, onFront, front, idx, w, h) {
  const x = idx % w, y = (idx / w) | 0
  const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
  for (const [nx, ny] of nb) {
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
    const nIdx = ny * w + nx
    if (filled[nIdx] === 0 && onFront[nIdx] === 0) {
      onFront[nIdx] = 1; front.push(nIdx)
    }
  }
}

/** 置信度项 C(p)：patch 内已填像素置信度之和 / patch 面积(Criminisi) */
function patchConfidence(conf, filled, x, y, w, h) {
  let sum = 0, area = 0
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
      area++
      if (filled[ny * w + nx]) sum += conf[ny * w + nx]
    }
  }
  return area > 0 ? sum / area : 0
}

/** 数据项 D(p)：结构线(isophote)与前沿法向的对齐度，保边缘/线条延续 */
function dataTerm(gray, filled, x, y, w, h) {
  const iso = maxIsophote(gray, filled, x, y, w, h)
  const nrm = frontNormal(filled, x, y, w, h)
  const dot = Math.abs(iso.ix * nrm.nx + iso.iy * nrm.ny)
  return dot / 255 + 0.001  // 归一化 + epsilon，平坦区也能推进
}

/** patch 内梯度幅值最大处的等照度线方向(梯度旋转90°)，只用完整已填点 */
function maxIsophote(gray, filled, x, y, w, h) {
  let bx = 0, by = 0, bmag = -1
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      const nx = x + dx, ny = y + dy
      if (nx <= 0 || nx >= w - 1 || ny <= 0 || ny >= h - 1) continue
      const idx = ny * w + nx
      if (!filled[idx] || !filled[idx - 1] || !filled[idx + 1] ||
          !filled[idx - w] || !filled[idx + w]) continue
      const gx = (gray[idx + 1] - gray[idx - 1]) / 2
      const gy = (gray[idx + w] - gray[idx - w]) / 2
      const mag = gx * gx + gy * gy
      if (mag > bmag) { bmag = mag; bx = gx; by = gy }
    }
  }
  return { ix: -by, iy: bx }
}

/** 前沿法向 n(p)：filled 场的梯度方向(指向已知/未知边界),归一化 */
function frontNormal(filled, x, y, w, h) {
  const xm = x > 0 ? filled[y * w + x - 1] : filled[y * w + x]
  const xp = x < w - 1 ? filled[y * w + x + 1] : filled[y * w + x]
  const ym = y > 0 ? filled[(y - 1) * w + x] : filled[y * w + x]
  const yp = y < h - 1 ? filled[(y + 1) * w + x] : filled[y * w + x]
  let nx = xp - xm, ny = yp - ym
  const len = Math.hypot(nx, ny)
  if (len < 1e-6) return { nx: 0, ny: 0 }
  return { nx: nx / len, ny: ny / len }
}

/**
 * 在 SEARCH_RADIUS 窗口内找 SSD 最小的完整已填源 patch。
 * 只比较目标 patch 中的已填像素，返回 {sx,sy,evaluated}。
 */
function findBestPatch(color, filled, gray, tx, ty, w, h) {
  let bestSSD = Infinity, sx = -1, sy = -1, evaluated = 0
  const x0 = Math.max(PATCH_RADIUS, tx - SEARCH_RADIUS)
  const x1 = Math.min(w - 1 - PATCH_RADIUS, tx + SEARCH_RADIUS)
  const y0 = Math.max(PATCH_RADIUS, ty - SEARCH_RADIUS)
  const y1 = Math.min(h - 1 - PATCH_RADIUS, ty + SEARCH_RADIUS)
  for (let cy = y0; cy <= y1; cy += SEARCH_STEP) {
    for (let cx = x0; cx <= x1; cx += SEARCH_STEP) {
      if (!patchFullyFilled(filled, cx, cy, w, h)) continue
      evaluated++
      const ssd = patchSSD(color, filled, tx, ty, cx, cy, w, h, bestSSD)
      if (ssd < bestSSD) { bestSSD = ssd; sx = cx; sy = cy }
    }
  }
  return { sx, sy, evaluated }
}

/** 源 patch 是否全部已填(可作为纹理来源) */
function patchFullyFilled(filled, x, y, w, h) {
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      if (!filled[(y + dy) * w + (x + dx)]) return false
    }
  }
  return true
}

/** RGB 空间 SSD，仅统计目标 patch 已填像素;超过 bestSSD 提前退出 */
function patchSSD(color, filled, tx, ty, sx, sy, w, h, bestSSD) {
  let sum = 0
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      const tnx = tx + dx, tny = ty + dy
      if (tnx < 0 || tnx >= w || tny < 0 || tny >= h) continue
      const ti = tny * w + tnx
      if (!filled[ti]) continue
      const si = (sy + dy) * w + (sx + dx)
      const dr = color[ti * 3] - color[si * 3]
      const dg = color[ti * 3 + 1] - color[si * 3 + 1]
      const db = color[ti * 3 + 2] - color[si * 3 + 2]
      sum += dr * dr + dg * dg + db * db
      if (sum >= bestSSD) return sum
    }
  }
  return sum
}

/**
 * 把源 patch 的真实纹理拷入目标 patch 的未填像素。
 * 更新 color/gray/conf/filled，并把新填像素记入 justFilled。
 * 若无可用源 patch(sx<0)，退化为用 patch 内已填像素均值填中心点。
 */
function copyPatch(color, filled, gray, conf, tx, ty, sx, sy, bestConf, w, h, justFilled) {
  if (sx < 0) { fillPatchMean(color, filled, gray, conf, tx, ty, bestConf, w, h, justFilled); return }
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      const tnx = tx + dx, tny = ty + dy
      if (tnx < 0 || tnx >= w || tny < 0 || tny >= h) continue
      const ti = tny * w + tnx
      if (filled[ti]) continue
      const si = (sy + dy) * w + (sx + dx)
      color[ti * 3] = color[si * 3]
      color[ti * 3 + 1] = color[si * 3 + 1]
      color[ti * 3 + 2] = color[si * 3 + 2]
      gray[ti] = gray[si]
      conf[ti] = bestConf
      filled[ti] = 1
      justFilled.push(ti)
    }
  }
}

/** 无匹配源时:用目标 patch 内已填像素均值填中心点(保证每轮至少推进1像素) */
function fillPatchMean(color, filled, gray, conf, tx, ty, bestConf, w, h, justFilled) {
  let r = 0, g = 0, b = 0, n = 0
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      const nx = tx + dx, ny = ty + dy
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
      const ni = ny * w + nx
      if (!filled[ni]) continue
      r += color[ni * 3]; g += color[ni * 3 + 1]; b += color[ni * 3 + 2]; n++
    }
  }
  const ti = ty * w + tx
  if (n > 0) { color[ti * 3] = r / n; color[ti * 3 + 1] = g / n; color[ti * 3 + 2] = b / n }
  gray[ti] = 0.299 * color[ti * 3] + 0.587 * color[ti * 3 + 1] + 0.114 * color[ti * 3 + 2]
  conf[ti] = bestConf
  filled[ti] = 1
  justFilled.push(ti)
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}
/**
 * Push-pull 金字塔填充（Gortler 等人的经典方法）。
 * 下采样(pull)逐层把已知颜色汇聚到低分辨率，上采样(push)再把低分辨率估计
 * 填回高分辨率的空洞处。空洞被周围颜色平滑插值填满，过渡自然。
 * @returns Float32Array 长度 w*h*3，所有像素都有颜色
 */
function pushPull(color, weight, w, h) {
  const levels = [{ color, weight, w, h }]

  // pull：一路下采样到 1x1
  let cur = levels[0]
  while (cur.w > 1 || cur.h > 1) {
    const nw = Math.max(1, Math.ceil(cur.w / 2))
    const nh = Math.max(1, Math.ceil(cur.h / 2))
    const nc = new Float32Array(nw * nh * 3)
    const nwt = new Float32Array(nw * nh)

    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let r = 0, g = 0, b = 0, wSum = 0, cnt = 0
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = x * 2 + dx, sy = y * 2 + dy
            if (sx >= cur.w || sy >= cur.h) continue
            cnt++
            const sIdx = sy * cur.w + sx
            const cw = cur.weight[sIdx]
            if (cw > 0) {
              r += cur.color[sIdx * 3] * cw
              g += cur.color[sIdx * 3 + 1] * cw
              b += cur.color[sIdx * 3 + 2] * cw
              wSum += cw
            }
          }
        }
        const dIdx = y * nw + x
        if (wSum > 0) {
          nc[dIdx * 3] = r / wSum
          nc[dIdx * 3 + 1] = g / wSum
          nc[dIdx * 3 + 2] = b / wSum
        }
        nwt[dIdx] = cnt > 0 ? wSum / cnt : 0
      }
    }
    cur = { color: nc, weight: nwt, w: nw, h: nh }
    levels.push(cur)
  }

  // push：从最粗一层往回，把上层颜色插值填入下层空洞
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l]
    const coarse = levels[l + 1]
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        const fIdx = y * fine.w + x
        const wf = fine.weight[fIdx]
        if (wf >= 1) continue // 已知像素保持不动
        const [cr, cg, cb] = sampleBilinear(coarse, (x - 0.5) / 2, (y - 0.5) / 2)
        // 已有部分颜色的按权重混合，纯空洞直接用上层估计
        fine.color[fIdx * 3] = wf * fine.color[fIdx * 3] + (1 - wf) * cr
        fine.color[fIdx * 3 + 1] = wf * fine.color[fIdx * 3 + 1] + (1 - wf) * cg
        fine.color[fIdx * 3 + 2] = wf * fine.color[fIdx * 3 + 2] + (1 - wf) * cb
        fine.weight[fIdx] = 1
      }
    }
  }

  return levels[0].color
}

/**
 * 在某一层做双线性采样，按各点权重加权，避免采到未填充点
 */
function sampleBilinear(level, fx, fy) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  let r = 0, g = 0, b = 0, wSum = 0
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const x = x0 + dx, y = y0 + dy
      if (x < 0 || x >= level.w || y < 0 || y >= level.h) continue
      const wx = 1 - Math.abs(fx - x)
      const wy = 1 - Math.abs(fy - y)
      const bw = Math.max(0, wx) * Math.max(0, wy)
      const idx = y * level.w + x
      const cw = level.weight[idx] * bw
      if (cw > 0) {
        r += level.color[idx * 3] * cw
        g += level.color[idx * 3 + 1] * cw
        b += level.color[idx * 3 + 2] * cw
        wSum += cw
      }
    }
  }
  if (wSum > 0) return [r / wSum, g / wSum, b / wSum]
  // 兜底：最近点
  const cx = Math.min(level.w - 1, Math.max(0, Math.round(fx)))
  const cy = Math.min(level.h - 1, Math.max(0, Math.round(fy)))
  const idx = cy * level.w + cx
  return [level.color[idx * 3], level.color[idx * 3 + 1], level.color[idx * 3 + 2]]
}

/**
 * 边界羽化：对 hole 边缘做轻微 3x3 均值，消除填充区与原图的接缝
 */
function featherBoundary(buffer, hole, width, height) {
  // 找出 hole 边界及其外一圈像素
  const edge = new Uint8Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (hole[idx] === 1) { edge[idx] = 1; continue }
      // 紧邻 hole 的原图像素也纳入，过渡更柔
      if (hole[idx - 1] || hole[idx + 1] || hole[idx - width] || hole[idx + width]) {
        edge[idx] = 1
      }
    }
  }

  const copy = Buffer.from(buffer)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (edge[idx] !== 1) continue
      const offset = idx * 4
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += copy[((y + dy) * width + (x + dx)) * 4 + c]
          }
        }
        // 60% 原值 + 40% 均值，轻微柔化
        buffer[offset + c] = Math.round(copy[offset + c] * 0.6 + (sum / 9) * 0.4)
      }
    }
  }
}

module.exports = { removeWatermark }
