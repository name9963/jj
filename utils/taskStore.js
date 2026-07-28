// Persistent asynchronous task store for CloudBase Run.
// CloudBase database is shared across instances, unlike an in-process Map.
const cloudbase = require('@cloudbase/node-sdk')

const COLLECTION = process.env.TASK_COLLECTION || 'async_tasks'
const ENV_ID = process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || process.env.SCF_NAMESPACE
const app = cloudbase.init(ENV_ID ? { env: ENV_ID } : {})
const db = app.database()
let collectionReady = false

function taskDocumentId(taskId) {
  return String(taskId).replace(/[^A-Za-z0-9_-]/g, '_')
}

function isCollectionMissing(err) {
  const message = `${err && err.code || ''} ${err && err.message || ''}`
  return /collection.*not.*exist|DATABASE_COLLECTION_NOT_EXIST|Db or Table not exist/i.test(message)
}

async function ensureCollection() {
  if (collectionReady) return
  try {
    await db.createCollection(COLLECTION)
  } catch (err) {
    const message = `${err && err.code || ''} ${err && err.message || ''}`
    if (!/already exists|exist/i.test(message)) throw err
  }
  collectionReady = true
}

async function withCollectionRetry(action) {
  try {
    return await action()
  } catch (err) {
    if (!isCollectionMissing(err)) throw err
    await ensureCollection()
    return action()
  }
}

async function setTask(taskId, data, ttlMs = 30 * 60 * 1000) {
  const now = new Date()
  const record = {
    ...data,
    taskId,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + ttlMs)
  }
  await withCollectionRetry(() => db.collection(COLLECTION).doc(taskDocumentId(taskId)).set(record))
  return record
}

async function getTask(taskId) {
  const result = await withCollectionRetry(() =>
    db.collection(COLLECTION).doc(taskDocumentId(taskId)).get()
  )
  const task = Array.isArray(result.data) ? result.data[0] : result.data
  if (!task) return null
  const expiresAt = toTimestamp(task.expiresAt)
  if (expiresAt && expiresAt <= Date.now()) {
    removeTask(taskId).catch(() => {})
    return null
  }
  return task
}

function toTimestamp(value) {
  if (!value) return 0
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value.toDate === 'function') return value.toDate().getTime()
  if (typeof value.$date === 'number') return value.$date
  return new Date(value).getTime() || 0
}

async function removeTask(taskId) {
  try {
    await db.collection(COLLECTION).doc(taskDocumentId(taskId)).remove()
  } catch (err) {
    if (!isCollectionMissing(err)) throw err
  }
}

module.exports = { setTask, getTask, removeTask }
