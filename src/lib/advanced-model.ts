import { sha256 } from '@noble/hashes/sha2.js'
import { db, deleteAdvancedModel, getModelChunks } from './db'
import { scannerClient } from './scanner-client'
import type {
  AdvancedModelRecord,
  ScanPage,
} from './types'
import { useAppStore } from '@/store/app-store'

export const ADVANCED_MODEL = {
  id: 'docshadow-sd7k-fp16',
  version: '1.0.0-fp16',
  url: '/models/docshadow-sd7k-fp16-v1.onnx',
  bytes: 62_045_318,
  sha256: '9728294ad65fa2d68c9c7b61fc8580555865d2dbdbbf46c326005283b2d44cc2',
  chunkBytes: 4 * 1024 * 1024,
} as const

let preparing: Promise<AdvancedModelRecord> | undefined

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

function installLabel(downloaded: number) {
  const mib = downloaded / 1024 / 1024
  const total = ADVANCED_MODEL.bytes / 1024 / 1024
  return `正在下载模型 ${mib.toFixed(1)} / ${total.toFixed(1)} MiB`
}

async function assertStorageHeadroom() {
  if (!navigator.storage?.estimate) return
  const estimate = await navigator.storage.estimate()
  if (!estimate.quota) return
  const free = estimate.quota - (estimate.usage ?? 0)
  const required = Math.ceil(ADVANCED_MODEL.bytes * 1.2)
  if (free < required) {
    throw new Error(
      `存储空间不足：高级模型还需要约 ${Math.ceil(required / 1024 / 1024)} MiB 可用空间`,
    )
  }
}

async function assembleModel() {
  const chunks = await getModelChunks(ADVANCED_MODEL.id)
  const total = chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0)
  if (total !== ADVANCED_MODEL.bytes) throw new Error('模型文件不完整，请重新安装')
  const model = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    model.set(new Uint8Array(chunk.data), offset)
    offset += chunk.data.byteLength
  }
  return model.buffer
}

async function activateStoredModel(record: AdvancedModelRecord) {
  useAppStore.getState().setModelState('installing', 99, '正在验证并启动高级模型', record)
  const model = await assembleModel()
  const runtime = await scannerClient.prepareAdvancedModel(
    model,
    window.isSecureContext && 'gpu' in navigator,
  )
  const ready: AdvancedModelRecord = {
    ...record,
    state: 'ready',
    downloadedBytes: ADVANCED_MODEL.bytes,
    installedAt: record.installedAt ?? Date.now(),
    backend: runtime.backend,
    benchmarkMs: runtime.benchmarkMs,
    inputSize: runtime.inputSize,
    error: undefined,
  }
  await db.models.put(ready)
  useAppStore.getState().setModelState('ready', 100, '高级去阴影已就绪', ready)
  return ready
}

export async function refreshAdvancedModelStatus() {
  const record = await db.models.get(ADVANCED_MODEL.id)
  if (!record) {
    useAppStore.getState().setModelState('not-installed', 0, '高级去阴影尚未安装')
    return undefined
  }
  const progress = Math.round((record.downloadedBytes / ADVANCED_MODEL.bytes) * 100)
  useAppStore.getState().setModelState(
    record.state,
    progress,
    record.state === 'ready'
      ? '高级去阴影已安装'
      : record.state === 'error'
        ? record.error ?? '模型安装失败'
        : installLabel(record.downloadedBytes),
    record,
  )
  return record
}

export async function prepareInstalledAdvancedModel(force = false) {
  if (!force && scannerClient.isAdvancedModelPrepared()) {
    const current = await db.models.get(ADVANCED_MODEL.id)
    if (current?.state === 'ready') return current
  }
  if (preparing) return preparing
  preparing = (async () => {
    const record = await db.models.get(ADVANCED_MODEL.id)
    if (!record || record.state !== 'ready') throw new Error('请先在设置中安装高级去阴影模型')
    if (force) await scannerClient.releaseAdvancedModel()
    return activateStoredModel(record)
  })().finally(() => {
    preparing = undefined
  })
  return preparing
}

export async function installAdvancedModel(
  signal?: AbortSignal,
  onProgress?: (downloaded: number, total: number) => void,
) {
  await assertStorageHeadroom()
  await deleteAdvancedModel(ADVANCED_MODEL.id)
  const initial: AdvancedModelRecord = {
    id: ADVANCED_MODEL.id,
    version: ADVANCED_MODEL.version,
    state: 'installing',
    expectedBytes: ADVANCED_MODEL.bytes,
    downloadedBytes: 0,
    sha256: ADVANCED_MODEL.sha256,
  }
  await db.models.put(initial)
  useAppStore.getState().setModelState('installing', 0, installLabel(0), initial)

  try {
    const response = await fetch(ADVANCED_MODEL.url, {
      cache: 'no-store',
      signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`模型下载失败（HTTP ${response.status}）`)
    }
    const reader = response.body.getReader()
    const digest = sha256.create()
    let pending = new Uint8Array(ADVANCED_MODEL.chunkBytes)
    let pendingLength = 0
    let downloaded = 0
    let chunkIndex = 0

    const flush = async (bytes: Uint8Array) => {
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      await db.modelChunks.put({ modelId: ADVANCED_MODEL.id, index: chunkIndex, data: copy.buffer })
      chunkIndex += 1
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (signal?.aborted) throw new DOMException('安装已取消', 'AbortError')
      digest.update(value)
      downloaded += value.byteLength
      let sourceOffset = 0
      while (sourceOffset < value.byteLength) {
        const copied = Math.min(
          pending.byteLength - pendingLength,
          value.byteLength - sourceOffset,
        )
        pending.set(value.subarray(sourceOffset, sourceOffset + copied), pendingLength)
        pendingLength += copied
        sourceOffset += copied
        if (pendingLength === pending.byteLength) {
          await flush(pending)
          pending = new Uint8Array(ADVANCED_MODEL.chunkBytes)
          pendingLength = 0
        }
      }
      const progress = Math.min(98, Math.round((downloaded / ADVANCED_MODEL.bytes) * 98))
      const next = { ...initial, downloadedBytes: downloaded }
      await db.models.put(next)
      useAppStore.getState().setModelState('installing', progress, installLabel(downloaded), next)
      onProgress?.(downloaded, ADVANCED_MODEL.bytes)
    }
    if (pendingLength) await flush(pending.slice(0, pendingLength))
    if (downloaded !== ADVANCED_MODEL.bytes) {
      throw new Error(`模型大小校验失败（收到 ${downloaded} 字节）`)
    }
    if (hex(digest.digest()) !== ADVANCED_MODEL.sha256) {
      throw new Error('模型完整性校验失败，请检查网络后重试')
    }
    if (navigator.storage?.persist) void navigator.storage.persist().catch(() => false)
    return await activateStoredModel({
      ...initial,
      downloadedBytes: downloaded,
      installedAt: Date.now(),
    })
  } catch (reason) {
    await scannerClient.releaseAdvancedModel().catch(() => undefined)
    await db.modelChunks.where('modelId').equals(ADVANCED_MODEL.id).delete()
    if (reason instanceof DOMException && reason.name === 'AbortError') {
      await db.models.delete(ADVANCED_MODEL.id)
      useAppStore.getState().setModelState('not-installed', 0, '安装已取消')
      throw reason
    }
    const message = reason instanceof Error ? reason.message : '模型安装失败'
    const failed: AdvancedModelRecord = { ...initial, state: 'error', error: message }
    await db.models.put(failed)
    useAppStore.getState().setModelState('error', 0, message, failed)
    throw reason
  }
}

export async function uninstallAdvancedModel() {
  await scannerClient.releaseAdvancedModel()
  await deleteAdvancedModel(ADVANCED_MODEL.id)
  useAppStore.getState().setModelState('not-installed', 0, '高级去阴影尚未安装')
}

export function correctionFingerprint(page: Pick<
  ScanPage,
  'id' | 'source' | 'sourceName' | 'corners' | 'rotation'
>) {
  const corners = page.corners
    .map((point) => `${point.x.toFixed(5)},${point.y.toFixed(5)}`)
    .join(';')
  return `v1:${page.id}:${page.sourceName}:${page.source.size}:${page.rotation}:${corners}`
}

export function hasUsableAdvancedCorrection(page: ScanPage) {
  return page.advancedCorrection?.fingerprint === correctionFingerprint(page)
}
