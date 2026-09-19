const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')

const WORKER_TIMEOUT_MS = Number(process.env.IMAGE_INPAINT_TIMEOUT_MS || 5 * 60 * 1000)

if (!isMainThread) {
  const { removeWatermark } = require('./imageInpaint')
  removeWatermark(workerData.imagePath, workerData.maskPath)
    .then(resultPath => parentPort.postMessage({ ok: true, resultPath }))
    .catch(err => parentPort.postMessage({ ok: false, error: err.message || '图片处理失败' }))
} else {
  let busy = false

  function runWorker(imagePath, maskPath, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error('任务已取消'))
      const worker = new Worker(__filename, {
        workerData: { imagePath, maskPath }
      })
      let settled = false

      const finish = (err, resultPath) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', abort)
        worker.terminate().catch(() => {})
        if (err) reject(err)
        else resolve(resultPath)
      }

      const timer = setTimeout(() => {
        finish(new Error('图片处理超时，请换一张尺寸较小的图片重试'))
      }, WORKER_TIMEOUT_MS)
      const abort = () => finish(new Error('任务已取消'))
      if (signal) signal.addEventListener('abort', abort, { once: true })

      worker.once('message', message => {
        if (message && message.ok) finish(null, message.resultPath)
        else finish(new Error((message && message.error) || '图片处理失败'))
      })
      worker.once('error', err => finish(err))
      worker.once('exit', code => {
        if (!settled) {
          finish(new Error(`图片处理线程异常退出（${code}）`))
        }
      })
    })
  }

  async function removeWatermarkInWorker(imagePath, maskPath, signal) {
    if (busy) throw new Error('图片处理繁忙，请稍后再试')
    busy = true
    try { return await runWorker(imagePath, maskPath, signal) } finally { busy = false }
  }

  module.exports = { removeWatermarkInWorker }
}
