const express = require('express')
const router = express.Router()
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const resources = require('../utils/resources')
const tasks = require('../utils/tasks')
const { transcribeVideo, MAX_SECONDS } = require('../utils/asrClient')
const { transcribeByParaformer, isParaformerEnabled } = require('../utils/paraformerClient')
const { downloadVideo } = require('../utils/mediaFetch')
const { parseVideo } = require('../utils/videoParser')

router.post('/extract', (req, res, next) => {
  try {
    const { link, videoUrl, requestId } = req.body || {}
    const data = tasks.submit(req.owner, 'caption', requestId, { link, videoUrl }, () => {
      if (Boolean(link) === Boolean(videoUrl)) {
        const err = new Error('请只提供一个分享链接或已上传的视频'); err.statusCode = 400; throw err
      }
      if (link) {
        if (typeof link !== 'string' || link.length > 2000) {
          const err = new Error('视频链接无效'); err.statusCode = 400; throw err
        }
        return { link }
      }
      return { resource: resources.owned(videoUrl, req.owner, 'video') }
    }, async (input, signal) => {
      let mediaPath
      if (input.resource) resources.pin(input.resource.id)
      try {
        if (input.link) {
          const parsed = await parseVideo(input.link)
          signal.throwIfAborted()
          if (parsed.isImage || !parsed.videoUrl) throw new Error('此链接没有可识别的视频语音')
          mediaPath = await downloadVideo(parsed.videoUrl, signal)
        } else {
          // 仅删除本任务工作副本，原始上传不受失败或重复任务影响。
          mediaPath = path.join(require('../utils/runtimePaths').workDir, 'caption_' + crypto.randomUUID() + '.mp4')
          await fs.promises.copyFile(input.resource.path, mediaPath)
        }
        signal.throwIfAborted()
        let text
        if (isParaformerEnabled()) {
          try { text = await transcribeByParaformer(mediaPath, signal) } catch (err) {
            signal.throwIfAborted()
          }
        }
        if (!text) text = await transcribeVideo(mediaPath, signal)
        return { text }
      } finally {
        if (mediaPath) await fs.promises.unlink(mediaPath).catch(() => {})
        if (input.resource) resources.unpin(input.resource.id)
      }
    })
    res.json({ code: 0, data: { ...data, maxSeconds: MAX_SECONDS } })
  } catch (err) { next(err) }
})
router.get('/result/:taskId', tasks.get)
module.exports = router
