import { useAppStore } from '@/store/app-store'
import scannerWorkerUrl from '../workers/scanner.worker.ts?worker&url'
import type {
  DetectionResult,
  PassportLayout,
  RenderOptions,
  ScanMode,
  ScanPage,
  ScannerWorkerRequest,
  ScannerWorkerResponse,
} from './types'
import { createId } from './utils'

type RequestIntent = 'init' | 'detect' | 'preview' | 'export'

export interface ScannerRenderRequestOptions {
  intent?: 'preview' | 'export'
  signal?: AbortSignal
}

interface RenderedResult {
  blob: Blob
  width: number
  height: number
}

interface QueuedRequest {
  message: ScannerWorkerRequest
  intent: RequestIntent
  timeoutMs: number
  sequence: number
  signal?: AbortSignal
  abortHandler?: () => void
  timeout?: number
  consumerSettled: boolean
  resolve: (response: ScannerWorkerResponse) => void
  reject: (error: Error) => void
}

interface RenderCacheEntry extends RenderedResult {
  pageId: string
}

const REQUEST_PRIORITY: Record<RequestIntent, number> = {
  export: 4,
  detect: 3,
  init: 2,
  preview: 1,
}

const MEBIBYTE = 1024 * 1024

function createAbortError() {
  return new DOMException('图像处理请求已取消', 'AbortError')
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function createRenderCacheKey(page: ScanPage, options: RenderOptions) {
  return JSON.stringify([
    page.id,
    page.createdAt,
    page.sourceName,
    page.source.size,
    page.source.type,
    page.corners.flatMap((point) => [point.x, point.y]),
    page.rotation,
    page.effects.shadow,
    page.effects.glare,
    page.effects.color,
    page.effects.detail,
    page.adjustments.brightness,
    page.adjustments.contrast,
    page.adjustments.sharpness,
    page.adjustments.shadowStrength,
    page.adjustments.whiteningStrength,
    options.maxEdge,
    options.mimeType,
    options.quality ?? 0.92,
  ])
}

export class ScannerClient {
  private worker: Worker | undefined
  private active: QueuedRequest | undefined
  private queue: QueuedRequest[] = []
  private sequence = 0
  private warmPromise: Promise<void> | undefined
  private renderCache = new Map<string, RenderCacheEntry>()
  private renderCacheBytes = 0
  private renderInflight = new Map<string, Promise<RenderedResult>>()

  private getWorker() {
    if (this.worker) return this.worker
    const openCvUrl = new URL(`${import.meta.env.BASE_URL}vendor/opencv.js`, window.location.origin)
      .href
    const moduleUrl = new URL(scannerWorkerUrl, window.location.origin).href
    const bootstrap = `
      const queuedMessages=[];
      const holdMessage=(event)=>queuedMessages.push(event.data);
      self.addEventListener('message',holdMessage);
      importScripts(${JSON.stringify(openCvUrl)});
      self.postMessage({id:'__bootstrap__',type:'progress',progress:3,label:'OpenCV 脚本已载入'});
      import(${JSON.stringify(moduleUrl)}).then(()=>{
        self.postMessage({id:'__bootstrap__',type:'progress',progress:6,label:'图像 Worker 已启动'});
        self.removeEventListener('message',holdMessage);
        queuedMessages.forEach((data)=>self.dispatchEvent(new MessageEvent('message',{data})));
      }).catch((error)=>setTimeout(()=>{throw error}));
    `
    const bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }))
    const worker = new Worker(bootstrapUrl)
    this.worker = worker
    window.setTimeout(() => URL.revokeObjectURL(bootstrapUrl), 10_000)
    worker.addEventListener('message', (event: MessageEvent<ScannerWorkerResponse>) => {
      if (this.worker !== worker) return
      this.handleResponse(event.data)
    })
    worker.addEventListener('error', (event) => {
      if (this.worker !== worker) return
      this.handleWorkerFailure(new Error(event.message || '图像处理 Worker 无法启动'))
    })
    return worker
  }

  private handleResponse(response: ScannerWorkerResponse) {
    if (response.type === 'progress') {
      if (response.id === '__bootstrap__' || response.id === this.active?.message.id) {
        useAppStore.getState().setEngineState(response.progress, response.label)
      }
      return
    }

    const request = this.active
    if (!request || request.message.id !== response.id) return
    if (request.timeout) window.clearTimeout(request.timeout)
    this.active = undefined
    if (response.type === 'error') {
      useAppStore.getState().setEngineState(100, '标准图像引擎可用')
      this.rejectConsumer(request, new Error(response.message))
    } else {
      useAppStore.getState().setEngineState(100, '本地图像引擎已就绪')
      this.resolveConsumer(request, response)
    }
    this.dispatchNext()
  }

  private handleWorkerFailure(error: Error) {
    const active = this.active
    if (active?.timeout) window.clearTimeout(active.timeout)
    if (active) this.rejectConsumer(active, error)
    this.queue.forEach((request) => this.rejectConsumer(request, error))
    this.active = undefined
    this.queue = []
    this.worker?.terminate()
    this.worker = undefined
    this.warmPromise = undefined
  }

  private resolveConsumer(request: QueuedRequest, response: ScannerWorkerResponse) {
    if (request.consumerSettled) return
    request.consumerSettled = true
    if (request.signal && request.abortHandler)
      request.signal.removeEventListener('abort', request.abortHandler)
    request.resolve(response)
  }

  private rejectConsumer(request: QueuedRequest, error: Error) {
    if (request.consumerSettled) return
    request.consumerSettled = true
    if (request.signal && request.abortHandler)
      request.signal.removeEventListener('abort', request.abortHandler)
    request.reject(error)
  }

  private abortRequest(request: QueuedRequest) {
    if (this.active === request) {
      this.rejectConsumer(request, createAbortError())
      return
    }
    const index = this.queue.indexOf(request)
    if (index >= 0) this.queue.splice(index, 1)
    this.rejectConsumer(request, createAbortError())
  }

  private cancelQueuedPreviews() {
    const cancelled = this.queue.filter((request) => request.intent === 'preview')
    if (!cancelled.length) return
    this.queue = this.queue.filter((request) => request.intent !== 'preview')
    cancelled.forEach((request) => this.rejectConsumer(request, createAbortError()))
  }

  private dispatchNext() {
    if (this.active || !this.queue.length) return
    let nextIndex = 0
    for (let index = 1; index < this.queue.length; index += 1) {
      const candidate = this.queue[index]
      const selected = this.queue[nextIndex]
      if (
        REQUEST_PRIORITY[candidate.intent] > REQUEST_PRIORITY[selected.intent] ||
        (REQUEST_PRIORITY[candidate.intent] === REQUEST_PRIORITY[selected.intent] &&
          candidate.sequence < selected.sequence)
      ) {
        nextIndex = index
      }
    }
    const [request] = this.queue.splice(nextIndex, 1)
    if (request.signal?.aborted) {
      this.rejectConsumer(request, createAbortError())
      this.dispatchNext()
      return
    }
    this.active = request
    request.timeout = window.setTimeout(() => {
      if (this.active !== request) return
      this.rejectConsumer(request, new Error('图像处理超时，请尝试尺寸更小的照片'))
      this.active = undefined
      this.worker?.terminate()
      this.worker = undefined
      this.warmPromise = undefined
      this.dispatchNext()
    }, request.timeoutMs)
    try {
      this.getWorker().postMessage(request.message)
    } catch (error) {
      this.handleWorkerFailure(
        error instanceof Error ? error : new Error('图像处理 Worker 无法启动'),
      )
    }
  }

  private request(
    message: ScannerWorkerRequest,
    {
      intent,
      timeoutMs = 90_000,
      signal,
    }: { intent: RequestIntent; timeoutMs?: number; signal?: AbortSignal },
  ) {
    return new Promise<ScannerWorkerResponse>((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError())
        return
      }
      if (intent === 'preview') this.cancelQueuedPreviews()
      const request: QueuedRequest = {
        message,
        intent,
        timeoutMs,
        signal,
        sequence: this.sequence,
        consumerSettled: false,
        resolve,
        reject,
      }
      this.sequence += 1
      if (signal) {
        request.abortHandler = () => this.abortRequest(request)
        signal.addEventListener('abort', request.abortHandler, { once: true })
      }
      this.queue.push(request)
      this.dispatchNext()
    })
  }

  private get renderCacheLimit() {
    const memory =
      typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    return (memory && memory >= 8 ? 96 : 32) * MEBIBYTE
  }

  private cachedRender(key: string) {
    const cached = this.renderCache.get(key)
    if (!cached) return undefined
    this.renderCache.delete(key)
    this.renderCache.set(key, cached)
    const { pageId: _pageId, ...rendered } = cached
    return rendered
  }

  private cacheRender(key: string, pageId: string, rendered: RenderedResult) {
    const size = rendered.blob.size
    const limit = this.renderCacheLimit
    if (size > limit) return
    const existing = this.renderCache.get(key)
    if (existing) {
      this.renderCacheBytes -= existing.blob.size
      this.renderCache.delete(key)
    }
    while (this.renderCacheBytes + size > limit) {
      const oldest = this.renderCache.entries().next().value as
        [string, RenderCacheEntry] | undefined
      if (!oldest) break
      this.renderCache.delete(oldest[0])
      this.renderCacheBytes -= oldest[1].blob.size
    }
    this.renderCache.set(key, { ...rendered, pageId })
    this.renderCacheBytes += size
  }

  invalidatePage(pageId: string) {
    for (const [key, cached] of this.renderCache) {
      if (cached.pageId !== pageId) continue
      this.renderCache.delete(key)
      this.renderCacheBytes -= cached.blob.size
    }
  }

  async prewarm() {
    if (!this.warmPromise) {
      this.warmPromise = this.request(
        { id: createId(), type: 'init' },
        { intent: 'init', timeoutMs: 90_000 },
      )
        .then((response) => {
          if (response.type !== 'ready') throw new Error('本地图像引擎初始化失败')
        })
        .catch((error: unknown) => {
          this.warmPromise = undefined
          throw error
        })
    }
    return this.warmPromise
  }

  async detect(source: Blob, mode: ScanMode, passportLayout?: PassportLayout) {
    const response = await this.request(
      {
        id: createId(),
        type: 'detect',
        source,
        mode,
        passportLayout,
      },
      { intent: 'detect' },
    )
    if (response.type !== 'detected') throw new Error('未收到边缘识别结果')
    return response.result as DetectionResult
  }

  async render(
    page: ScanPage,
    options: RenderOptions,
    requestOptions: ScannerRenderRequestOptions = {},
  ) {
    const intent = requestOptions.intent ?? 'preview'
    const cacheKey = intent === 'export' ? createRenderCacheKey(page, options) : undefined
    if (cacheKey) {
      const cached = this.cachedRender(cacheKey)
      if (cached) return cached
      const inflight = this.renderInflight.get(cacheKey)
      if (inflight) return inflight
    }

    const task = this.request(
      {
        id: createId(),
        type: 'render',
        page,
        options,
      },
      { intent, signal: requestOptions.signal },
    ).then((response) => {
      if (response.type !== 'rendered') throw new Error('未收到图像处理结果')
      return {
        blob: response.blob,
        width: response.width,
        height: response.height,
      }
    })

    if (!cacheKey) return task
    this.renderInflight.set(cacheKey, task)
    try {
      const rendered = await task
      this.cacheRender(cacheKey, page.id, rendered)
      return rendered
    } finally {
      this.renderInflight.delete(cacheKey)
    }
  }
}

export const scannerClient = new ScannerClient()
