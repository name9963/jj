const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')

const WORKER_TIMEOUT_MS = Number(process.env.IMAGE_INPAINT_TIMEOUT_MS || 5 * 60 * 1000)

if (!isMainThread) {
  const { removeWatermark } = require('./imageInpaint')
  removeWatermark(workerData.imagePath, workerData.maskPath)
    .then(resultPath => parentPort.postMessage({ ok: true, resultPath }))
    .catch(err => parentPort.postMessage({ ok: false, error: err.message || '图片处理失败' }))
} else {
  let queue = Promise.resolve()

  function runWorker(imagePath, maskPath) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { imagePath, maskPath }
      })
      let settled = false

      const finish = (err, resultPath) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        worker.terminate().catch(() => {})
        if (err) reject(err)
        else resolve(resultPath)
      }

      const timer = setTimeout(() => {
        finish(new Error('图片处理超时，请换一张尺寸较小的图片重试'))
      }, WORKER_TIMEOUT_MS)

      worker.once('message', message => {
        if (message && message.ok) finish(null, message.resultPath)
        else finish(new Error((message && message.error) || '图片处理失败'))
      })
      worker.once('error', err => finish(err))
      worker.once('exit', code => {
        if (!settled && code !== 0) {
          finish(new Error(`图片处理线程异常退出（${code}）`))
        }
      })
    })
  }

  function removeWatermarkInWorker(imagePath, maskPath) {
    const task = queue.then(
      () => runWorker(imagePath, maskPath),
      () => runWorker(imagePath, maskPath)
    )
    queue = task.catch(() => {})
    return task
  }

  module.exports = { removeWatermarkInWorker }
}
