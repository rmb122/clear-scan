import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_QUAD } from '@/lib/geometry'
import {
  ENGINE_INITIALIZATION_TIMEOUT_MS,
  ScannerClient,
  createRenderCacheKey,
  isAbortError,
  isEngineTimeout,
} from '@/lib/scanner-client'
import { messages, setLocale } from '@/lib/i18n'
import { DEFAULT_WATERMARK, type ScannerWorkerRequest, type WatermarkSettings } from '@/lib/types'
import { makePage } from '../../support/scan-fixtures'

class WorkerMock extends EventTarget {
  static instances: WorkerMock[] = []
  messages: ScannerWorkerRequest[] = []
  terminated = false

  constructor() {
    super()
    WorkerMock.instances.push(this)
  }

  postMessage(message: ScannerWorkerRequest) {
    this.messages.push(message)
  }

  terminate() {
    this.terminated = true
  }

  respond(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

beforeEach(() => {
  WorkerMock.instances = []
  vi.stubGlobal('Worker', WorkerMock)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:scanner-worker')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('scanner request scheduling', () => {
  it('forwards progress from the active detection request only', async () => {
    const client = new ScannerClient()
    const onProgress = vi.fn()
    const detection = client.detect(new Blob(['source']), 'document', undefined, { onProgress })
    const worker = WorkerMock.instances[0]
    const request = worker.messages[0]
    expect(onProgress).toHaveBeenCalledWith(0, '正在下载图像引擎（约 11 MB），可能需要一些时间')

    worker.respond({
      id: '__bootstrap__',
      type: 'progress',
      progress: 6,
      label: '图像 Worker 已启动',
    })
    expect(onProgress).toHaveBeenCalledTimes(1)

    worker.respond({
      id: request.id,
      type: 'progress',
      progress: 35,
      label: '正在分析文档边缘',
    })
    expect(onProgress).toHaveBeenCalledWith(35, '正在分析文档边缘')
    expect(client.isReady).toBe(true)

    worker.respond({
      id: request.id,
      type: 'detected',
      result: {
        width: 1200,
        height: 900,
        corners: DEFAULT_QUAD,
        confidence: 0.9,
        cornerSource: 'detected',
        glareLevel: 'none',
      },
    })
    await detection
  })

  it('keeps only the newest queued preview', async () => {
    const client = new ScannerClient()
    const options = { maxEdge: 1400, mimeType: 'image/jpeg' as const, quality: 0.9 }
    const page = makePage()
    const first = client.render(page, options, { intent: 'preview' })
    const second = client.render(
      { ...page, adjustments: { ...page.adjustments, brightness: 1 } },
      options,
      { intent: 'preview' },
    )
    const secondRejected = second.catch((error: unknown) => error)
    const third = client.render(
      { ...page, adjustments: { ...page.adjustments, brightness: 2 } },
      options,
      { intent: 'preview' },
    )
    const worker = WorkerMock.instances[0]

    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0].type).toBe('render')
    expect(isAbortError(await secondRejected)).toBe(true)

    worker.respond({
      id: worker.messages[0].id,
      type: 'rendered',
      blob: new Blob(['first']),
      width: 100,
      height: 80,
    })
    await first
    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]).toMatchObject({
      type: 'render',
      cacheIntermediate: true,
      page: { adjustments: { brightness: 2 } },
    })

    worker.respond({
      id: worker.messages[1].id,
      type: 'rendered',
      blob: new Blob(['third']),
      width: 100,
      height: 80,
    })
    await third
  })

  it('prewarms once and reuses an identical export render', async () => {
    const client = new ScannerClient()
    const firstProgress = vi.fn()
    const warming = client.prewarm({ onProgress: firstProgress })
    const worker = WorkerMock.instances[0]
    expect(worker.messages[0].type).toBe('init')
    expect(client.isReady).toBe(false)
    expect(firstProgress).toHaveBeenLastCalledWith(
      5,
      '正在下载图像引擎（约 11 MB），可能需要一些时间',
    )

    worker.respond({
      id: worker.messages[0].id,
      type: 'progress',
      progress: 14,
      label: '正在编译图像算法',
    })
    expect(firstProgress).toHaveBeenLastCalledWith(60, '正在编译图像算法')

    const joinedProgress = vi.fn()
    const joinedWarming = client.prewarm({ onProgress: joinedProgress })
    expect(joinedProgress).toHaveBeenLastCalledWith(60, '正在编译图像算法')

    worker.respond({ id: worker.messages[0].id, type: 'ready' })
    await Promise.all([warming, joinedWarming])
    expect(client.isReady).toBe(true)
    expect(firstProgress).toHaveBeenLastCalledWith(100, '图像引擎已就绪')
    expect(joinedProgress).toHaveBeenLastCalledWith(100, '图像引擎已就绪')

    const readyProgress = vi.fn()
    await client.prewarm({ onProgress: readyProgress })
    expect(readyProgress).toHaveBeenCalledWith(100, '图像引擎已就绪')
    expect(worker.messages).toHaveLength(1)

    const page = makePage()
    const options = { maxEdge: 3000, mimeType: 'image/jpeg' as const, quality: 0.94 }
    const first = client.render(page, options, { intent: 'export' })
    expect(worker.messages).toHaveLength(2)
    worker.respond({
      id: worker.messages[1].id,
      type: 'rendered',
      blob: new Blob(['export']),
      width: 3000,
      height: 2250,
    })
    const rendered = await first
    const cached = await client.render(page, options, { intent: 'export' })

    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]).toMatchObject({ type: 'render', cacheIntermediate: false })
    expect(cached).toEqual(rendered)

    client.invalidatePage(page.id)
    expect(worker.messages[2]).toMatchObject({ type: 'invalidate-cache', pageId: page.id })
    const rerendered = client.render(page, options, { intent: 'export' })
    expect(worker.messages[3]).toMatchObject({ type: 'render', cacheIntermediate: false })
    worker.respond({
      id: worker.messages[3].id,
      type: 'rendered',
      blob: new Blob(['rerendered-export']),
      width: 3000,
      height: 2250,
    })
    expect((await rerendered).blob).not.toBe(rendered.blob)
  })

  it('keeps timeout identity and retries in the selected language', async () => {
    vi.useFakeTimers()
    try {
      const client = new ScannerClient()
      const warming = client.prewarm()
      const failure = warming.catch((error: unknown) => error)
      const firstWorker = WorkerMock.instances[0]

      await vi.advanceTimersByTimeAsync(ENGINE_INITIALIZATION_TIMEOUT_MS)

      expect(await failure).toMatchObject({ message: messages.engineTimeout })
      setLocale('en')
      expect(isEngineTimeout(await failure)).toBe(true)
      expect(firstWorker.terminated).toBe(true)
      expect(client.isReady).toBe(false)

      const retry = client.prewarm()
      const secondWorker = WorkerMock.instances[1]
      expect(secondWorker.messages[0]).toMatchObject({ type: 'init', locale: 'en' })
      secondWorker.respond({ id: secondWorker.messages[0].id, type: 'ready' })

      await retry
      expect(client.isReady).toBe(true)
    } finally {
      setLocale('zh-CN')
      vi.useRealTimers()
    }
  })

  it('uses the engine timeout while a cold detection is still initializing', async () => {
    vi.useFakeTimers()
    try {
      const client = new ScannerClient()
      let settled = false
      const failure = client
        .detect(new Blob(['source']), 'document')
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true
        })

      await vi.advanceTimersByTimeAsync(90_000)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(ENGINE_INITIALIZATION_TIMEOUT_MS - 90_000)
      expect(await failure).toMatchObject({ message: messages.engineTimeout })
      expect(WorkerMock.instances[0].terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets detection consumers cancel without reporting a processing failure', async () => {
    const client = new ScannerClient()
    const controller = new AbortController()
    const onProgress = vi.fn()
    const detection = client.detect(new Blob(['source']), 'document', undefined, {
      signal: controller.signal,
      onProgress,
    })
    const failure = detection.catch((error: unknown) => error)
    const worker = WorkerMock.instances[0]

    controller.abort()
    expect(isAbortError(await failure)).toBe(true)
    expect(worker.terminated).toBe(false)

    worker.respond({
      id: worker.messages[0].id,
      type: 'progress',
      progress: 35,
      label: '正在分析文档边缘',
    })
    worker.respond({
      id: worker.messages[0].id,
      type: 'detected',
      result: {
        width: 1200,
        height: 900,
        corners: DEFAULT_QUAD,
        confidence: 0.9,
        cornerSource: 'detected',
        glareLevel: 'none',
      },
    })
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(client.isReady).toBe(true)
  })
})

describe('render cache keys', () => {
  it('distinguishes watermark edits while reusing the unmarked render when disabled or blank', () => {
    const page = makePage()
    const options = { maxEdge: 3000, mimeType: 'image/png' as const }
    const watermark = { ...DEFAULT_WATERMARK, enabled: true, text: '仅供申请使用' }
    const original = createRenderCacheKey(page, { ...options, watermark })
    const changes: Partial<WatermarkSettings>[] = [
      { text: '仅供审核使用' },
      { color: '#ff0000' },
      { opacity: 50 },
      { fontSize: 48 },
      { angle: 30 },
      { spacing: 120 },
      { enabled: false },
    ]
    for (const change of changes) {
      expect(
        createRenderCacheKey(page, { ...options, watermark: { ...watermark, ...change } }),
      ).not.toBe(original)
    }
    for (const change of [{ enabled: false }, { text: '   ' }]) {
      expect(
        createRenderCacheKey(page, { ...options, watermark: { ...watermark, ...change } }),
      ).toBe(createRenderCacheKey(page, options))
    }
  })

  it('ignores autosave timestamps but changes with pixels or output options', () => {
    const options = { maxEdge: 3000, mimeType: 'image/jpeg' as const, quality: 0.94 }
    const original = makePage()
    expect(createRenderCacheKey({ ...original, updatedAt: 99 }, options)).toBe(
      createRenderCacheKey(original, options),
    )
    expect(
      createRenderCacheKey(
        { ...original, adjustments: { ...original.adjustments, brightness: 1 } },
        options,
      ),
    ).not.toBe(createRenderCacheKey(original, options))
    expect(
      createRenderCacheKey(
        {
          ...original,
          adjustments: { ...original.adjustments, whiteningStrength: 40 },
        },
        options,
      ),
    ).not.toBe(createRenderCacheKey(original, options))
    expect(createRenderCacheKey(original, { ...options, maxEdge: 2999 })).not.toBe(
      createRenderCacheKey(original, options),
    )
  })
})
