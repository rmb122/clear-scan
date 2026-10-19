/// <reference lib="webworker" />

import type { CV } from '@techstark/opencv-js'
import { DETECTION_CONFIDENCE_THRESHOLD } from '@/lib/document-detection'
import { orderPoints } from '@/lib/geometry'
import type {
  DetectionResult,
  PassportLayout,
  RenderOptions,
  ScanMode,
  ScanPage,
  ScannerWorkerRequest,
  ScannerWorkerResponse,
} from '@/lib/types'
import { findDocumentQuad } from './document-detector'
import { detectGlare } from './image-enhancer'
import { clearRenderPipelineCache, renderPage } from './page-renderer'
import { blobToImageData } from './worker-image-utils'
import { messages, setLocale } from '@/lib/i18n'

const workerScope = self as unknown as DedicatedWorkerGlobalScope & {
  cv?: CV | Promise<CV>
}
let cvReadyPromise: Promise<void> | undefined
let cvRuntime: CV | undefined

function post(message: ScannerWorkerResponse) {
  workerScope.postMessage(message)
}

function ensureOpenCv(requestId: string) {
  if (!cvReadyPromise) {
    cvReadyPromise = (async () => {
      const candidate = workerScope.cv as CV | Promise<CV>
      if (!candidate) throw new Error(messages.openCvLoadFailed)
      post({
        id: requestId,
        type: 'progress',
        progress: 10,
        label: messages.initializingOpenCv,
      })
      if (candidate instanceof Promise) {
        cvRuntime = await candidate
        return
      }
      const module = candidate as CV
      const moduleThen = (
        module as unknown as {
          then?: (callback: () => void) => unknown
        }
      ).then
      if (typeof moduleThen === 'function') {
        post({
          id: requestId,
          type: 'progress',
          progress: 14,
          label: messages.compilingAlgorithms,
        })
        await new Promise<void>((resolve) => {
          moduleThen.call(module, () => {
            post({
              id: requestId,
              type: 'progress',
              progress: 22,
              label: messages.openCvReady,
            })
            resolve()
          })
        })
        cvRuntime = module
        return
      }
      if (typeof module.getBuildInformation === 'function') {
        cvRuntime = module
        return
      }
      await new Promise<void>((resolve) => {
        module.onRuntimeInitialized = () => resolve()
      })
      cvRuntime = module
    })()
  }
  return cvReadyPromise
}

async function detectDocument(
  id: string,
  sourceBlob: Blob,
  mode: ScanMode,
  passportLayout?: PassportLayout,
) {
  post({ id, type: 'progress', progress: 8, label: messages.readingPhoto })
  await ensureOpenCv(id)
  clearRenderPipelineCache()
  const cv = cvRuntime
  if (!cv) throw new Error(messages.openCvNotReady)
  post({ id, type: 'progress', progress: 35, label: messages.analyzingEdges })
  const { imageData, sourceWidth, sourceHeight } = await blobToImageData(sourceBlob, 1600)
  const source = cv.matFromImageData(imageData)
  try {
    post({ id, type: 'progress', progress: 54, label: messages.comparingEdges })
    const detection = findDocumentQuad(
      cv,
      source,
      imageData,
      mode,
      passportLayout,
      (progress, label) => post({ id, type: 'progress', progress, label }),
    )
    const accepted = Boolean(
      detection.best && detection.confidence >= DETECTION_CONFIDENCE_THRESHOLD,
    )
    const fallback = orderPoints([
      { x: 0.04, y: 0.04 },
      { x: 0.96, y: 0.04 },
      { x: 0.96, y: 0.96 },
      { x: 0.04, y: 0.96 },
    ])
    const result: DetectionResult = {
      width: sourceWidth,
      height: sourceHeight,
      corners: accepted && detection.best ? detection.best.corners : fallback,
      confidence: detection.confidence,
      cornerSource: accepted ? 'detected' : 'fallback',
      glareLevel: detectGlare(cv, source),
    }
    post({ id, type: 'progress', progress: 100, label: messages.edgeDetectionComplete })
    post({ id, type: 'detected', result })
  } finally {
    source.delete()
  }
}

async function initialize(id: string) {
  await ensureOpenCv(id)
  post({ id, type: 'ready' })
}

async function renderDocument(
  id: string,
  page: ScanPage,
  options: RenderOptions,
  cacheIntermediate = false,
) {
  post({ id, type: 'progress', progress: 10, label: messages.readingOriginal })
  await ensureOpenCv(id)
  const cv = cvRuntime
  if (!cv) throw new Error(messages.openCvNotReady)
  const rendered = await renderPage(cv, page, options, cacheIntermediate, (progress, label) =>
    post({ id, type: 'progress', progress, label }),
  )
  post({ id, type: 'rendered', ...rendered })
}

workerScope.addEventListener('message', (event: MessageEvent<ScannerWorkerRequest>) => {
  const request = event.data
  if (request.type === 'invalidate-cache') {
    clearRenderPipelineCache(request.pageId)
    return
  }
  setLocale(request.locale)
  const task =
    request.type === 'init'
      ? initialize(request.id)
      : request.type === 'detect'
        ? detectDocument(request.id, request.source, request.mode, request.passportLayout)
        : renderDocument(request.id, request.page, request.options, request.cacheIntermediate)

  void task.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : messages.imageProcessingFailed
    post({ id: request.id, type: 'error', message })
  })
})
