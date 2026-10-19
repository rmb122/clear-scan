import scannerWorkerUrl from '../workers/scanner.worker.ts?worker&url'
import { ENGINE_CACHE_NAME, getOpenCvUrl } from './engine-cache'
import type {
  PassportLayout,
  RenderOptions,
  ScanMode,
  ScanPage,
  ScannerWorkerRequest,
  ScannerWorkerResponse,
} from './types'
import { createId } from './utils'
import { locale, messages } from './i18n'
import { hasWatermark } from './watermark'

type RequestIntent = 'init' | 'detect' | 'preview' | 'export'
type TimeoutMessage =
  'processingTimeout' | 'engineTimeout' | 'detectionTimeout' | 'previewTimeout' | 'exportTimeout'

export interface ScannerRenderRequestOptions {
  intent?: 'preview' | 'export'
  signal?: AbortSignal
}

export interface ScannerDetectionRequestOptions {
  signal?: AbortSignal
  onProgress?: (progress: number, label: string) => void
}

export interface ScannerPrewarmRequestOptions {
  onProgress?: (progress: number, label: string) => void
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
  timeoutMessage: TimeoutMessage
  sequence: number
  signal?: AbortSignal
  onProgress?: (progress: number, label: string) => void
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
const ENGINE_LOADING_PROGRESS = 5
const ENGINE_RUNTIME_READY_PROGRESS = 22
export const ENGINE_INITIALIZATION_TIMEOUT_MS = 128_000

export function isEngineTimeout(error: unknown) {
  return error instanceof Error && error.name === 'EngineTimeoutError'
}

function normalizeEngineProgress(progress: number) {
  return Math.max(
    ENGINE_LOADING_PROGRESS,
    Math.min(95, Math.round((progress / ENGINE_RUNTIME_READY_PROGRESS) * 95)),
  )
}

function createAbortError() {
  return new DOMException(messages.processingAborted, 'AbortError')
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function createRenderCacheKey(page: ScanPage, options: RenderOptions) {
  const watermark = options.watermark
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
    hasWatermark(watermark)
      ? [
          watermark.text.trim(),
          watermark.fontSize,
          watermark.opacity,
          watermark.color,
          watermark.angle,
          watermark.spacing,
        ]
      : null,
  ])
}

export class ScannerClient {
  private worker: Worker | undefined
  private active: QueuedRequest | undefined
  private queue: QueuedRequest[] = []
  private sequence = 0
  private warmPromise: Promise<void> | undefined
  private engineReady = false
  private warmProgress: { progress: number; label: string } | undefined
  private warmProgressListeners = new Set<(progress: number, label: string) => void>()
  private renderCache = new Map<string, RenderCacheEntry>()
  private renderCacheBytes = 0
  private renderInflight = new Map<string, Promise<RenderedResult>>()

  get isReady() {
    return this.engineReady
  }

  private reportWarmProgress(progress: number, label: string) {
    this.warmProgress = { progress, label }
    this.warmProgressListeners.forEach((listener) => listener(progress, label))
  }

  private getWorker() {
    if (this.worker) return this.worker
    const openCvUrl = getOpenCvUrl()
    const moduleUrl = new URL(scannerWorkerUrl, window.location.origin).href
    const bootstrap = `
      const queuedMessages=[];
      const holdMessage=(event)=>queuedMessages.push(event.data);
      self.addEventListener('message',holdMessage);
      const openCvUrl=${JSON.stringify(openCvUrl)};
      const engineCacheName=${JSON.stringify(ENGINE_CACHE_NAME)};
      const loadOpenCv=async()=>{
        let cache;
        if('caches' in self){
          try{cache=await caches.open(engineCacheName)}catch{}
        }
        let response;
        if(cache){
          try{response=await cache.match(openCvUrl)}catch{}
        }
        let cacheWrite=Promise.resolve();
        if(!response){
          response=await fetch(openCvUrl);
          if(!response.ok)throw new Error(${JSON.stringify(messages.engineDownloadFailed)}+' (HTTP '+response.status+')');
          if(cache)cacheWrite=cache.put(openCvUrl,response.clone()).catch(()=>undefined);
        }
        const source=await response.blob();
        const sourceUrl=URL.createObjectURL(source);
        try{
          importScripts(sourceUrl);
          await cacheWrite;
        }catch(error){
          await cacheWrite;
          if(cache){try{await cache.delete(openCvUrl)}catch{}}
          throw error;
        }finally{
          URL.revokeObjectURL(sourceUrl);
        }
      };
      loadOpenCv().then(()=>import(${JSON.stringify(moduleUrl)})).then(()=>{
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
      this.handleWorkerFailure(new Error(event.message || messages.workerStartFailed))
    })
    return worker
  }

  private handleResponse(response: ScannerWorkerResponse) {
    if (response.type === 'progress') {
      const activeRequest = response.id === this.active?.message.id ? this.active : undefined
      if (!activeRequest) return
      if (
        (activeRequest.intent === 'detect' && response.progress >= 35) ||
        ((activeRequest.intent === 'preview' || activeRequest.intent === 'export') &&
          response.progress >= 42)
      ) {
        this.engineReady = true
      }
      if (!activeRequest.consumerSettled)
        activeRequest.onProgress?.(response.progress, response.label)
      return
    }

    const request = this.active
    if (!request || request.message.id !== response.id) return
    if (request.timeout) window.clearTimeout(request.timeout)
    this.active = undefined
    if (response.type === 'detected' || response.type === 'rendered') this.engineReady = true
    if (response.type === 'error') {
      this.rejectConsumer(request, new Error(response.message))
    } else {
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
    this.engineReady = false
    this.warmProgress = undefined
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
      const timeoutMessage =
        request.intent !== 'init' && !this.engineReady ? 'engineTimeout' : request.timeoutMessage
      const error = new Error(messages[timeoutMessage])
      if (timeoutMessage === 'engineTimeout') error.name = 'EngineTimeoutError'
      this.rejectConsumer(request, error)
      this.active = undefined
      this.worker?.terminate()
      this.worker = undefined
      this.warmPromise = undefined
      this.engineReady = false
      this.warmProgress = undefined
      this.dispatchNext()
    }, request.timeoutMs)
    try {
      this.getWorker().postMessage({ ...request.message, locale })
    } catch (error) {
      this.handleWorkerFailure(
        error instanceof Error ? error : new Error(messages.workerStartFailed),
      )
    }
  }

  private request(
    message: ScannerWorkerRequest,
    {
      intent,
      timeoutMs = 90_000,
      timeoutMessage = 'processingTimeout',
      signal,
      onProgress,
    }: {
      intent: RequestIntent
      timeoutMs?: number
      timeoutMessage?: TimeoutMessage
      signal?: AbortSignal
      onProgress?: (progress: number, label: string) => void
    },
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
        timeoutMessage,
        signal,
        onProgress,
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
    this.worker?.postMessage({ id: createId(), type: 'invalidate-cache', pageId, locale })
  }

  prewarm({ onProgress }: ScannerPrewarmRequestOptions = {}) {
    if (this.engineReady) {
      onProgress?.(100, messages.engineReady)
      return Promise.resolve()
    }

    if (onProgress) {
      this.warmProgressListeners.add(onProgress)
      if (this.warmProgress) onProgress(this.warmProgress.progress, this.warmProgress.label)
    }

    if (!this.warmPromise) {
      this.reportWarmProgress(ENGINE_LOADING_PROGRESS, messages.engineDownload)
      this.warmPromise = this.request(
        { id: createId(), type: 'init', locale },
        {
          intent: 'init',
          timeoutMs: ENGINE_INITIALIZATION_TIMEOUT_MS,
          timeoutMessage: 'engineTimeout',
          onProgress: (progress, label) =>
            this.reportWarmProgress(normalizeEngineProgress(progress), label),
        },
      )
        .then((response) => {
          if (response.type !== 'ready') throw new Error(messages.engineInitFailed)
          this.engineReady = true
          this.reportWarmProgress(100, messages.engineReady)
        })
        .catch((error: unknown) => {
          this.engineReady = false
          this.warmProgress = undefined
          this.warmPromise = undefined
          throw error
        })
    }

    return this.warmPromise.finally(() => {
      if (onProgress) this.warmProgressListeners.delete(onProgress)
    })
  }

  async detect(
    source: Blob,
    mode: ScanMode,
    passportLayout?: PassportLayout,
    requestOptions: ScannerDetectionRequestOptions = {},
  ) {
    const requiresInitialization = !this.engineReady
    if (requiresInitialization) requestOptions.onProgress?.(0, messages.engineDownload)
    const response = await this.request(
      {
        id: createId(),
        type: 'detect',
        locale,
        source,
        mode,
        passportLayout,
      },
      {
        intent: 'detect',
        timeoutMs: requiresInitialization ? ENGINE_INITIALIZATION_TIMEOUT_MS : undefined,
        timeoutMessage: 'detectionTimeout',
        signal: requestOptions.signal,
        onProgress: requestOptions.onProgress,
      },
    )
    if (response.type !== 'detected') throw new Error(messages.missingDetection)
    this.engineReady = true
    return response.result
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

    const requiresInitialization = !this.engineReady
    const task = this.request(
      {
        id: createId(),
        type: 'render',
        locale,
        page,
        options,
        cacheIntermediate: intent === 'preview',
      },
      {
        intent,
        timeoutMs: requiresInitialization ? ENGINE_INITIALIZATION_TIMEOUT_MS : undefined,
        timeoutMessage: intent === 'export' ? 'exportTimeout' : 'previewTimeout',
        signal: requestOptions.signal,
      },
    ).then((response) => {
      if (response.type !== 'rendered') throw new Error(messages.missingRender)
      this.engineReady = true
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
