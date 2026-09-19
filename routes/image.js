const express = require('express')
const router = express.Router()
const resources = require('../utils/resources')
const tasks = require('../utils/tasks')
const { inpaintByLama } = require('../utils/lamaClient')
const { removeWatermarkInWorker } = require('../utils/imageInpaintWorker')

router.post('/remove-watermark', (req, res, next) => {
  try {
    const { imageUrl, maskUrl, requestId } = req.body || {}
    const data = tasks.submit(req.owner, 'image', requestId, { imageUrl, maskUrl }, () => ({
      image: resources.owned(imageUrl, req.owner, 'image'),
      mask: resources.owned(maskUrl, req.owner, 'image')
    }), async ({ image, mask }, signal) => {
      resources.pin(image.id); resources.pin(mask.id)
      let resultPath
      try {
      try { resultPath = await inpaintByLama(image.path, mask.path, signal) } catch (err) {
        signal.throwIfAborted()
        // 未配置 SHILIU_API_KEY、KEY 无效、超时、额度不足都会走到这里并静默回退本地算法。
        // 没有这行日志时，线上日志里完全看不出云端修复到底走的是哪条链路
        // （表现为"功能正常但效果一般"，无法定位是 KEY 没生效还是算法本身如此）。
        console.warn(`[Image] 石榴 API 未生效，回退本地算法: ${err.message}`)
        resultPath = await removeWatermarkInWorker(image.path, mask.path, signal)
      }
      signal.throwIfAborted()
      const result = resources.register(resultPath, req.owner, 'result')
      return { resourceId: result.id }
      } finally { resources.unpin(image.id); resources.unpin(mask.id) }
    })
    res.json({ code: 0, data })
  } catch (err) { next(err) }
})
router.get('/result/:taskId', tasks.get)
module.exports = router
