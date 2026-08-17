/// <reference lib="webworker" />

import type { CV } from '@techstark/opencv-js'
import { DETECTION_CONFIDENCE_THRESHOLD } from '@/lib/document-detection'
import { orderPoints } from '@/lib/geometry'
import type {
  DetectionResult,
  PassportLayout,
  ScanMode,
  ScanPage,
  ScannerWorkerRequest,
  ScannerWorkerResponse,
} from '@/lib/types'
import { findDocumentQuad } from './document-detector'
import { detectGlare } from './image-enhancer'
import { renderPage } from './page-renderer'
import { blobToImageData } from './worker-image-utils'

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
      if (!candidate) throw new Error('OpenCV 本地图像引擎载入失败')
      post({
        id: requestId,
        type: 'progress',
        progress: 10,
        label: '正在初始化 OpenCV',
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
          label: '正在编译图像算法',
        })
        await new Promise<void>((resolve) => {
          moduleThen.call(module, () => {
            post({
              id: requestId,
              type: 'progress',
              progress: 22,
              label: 'OpenCV 已就绪',
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
  post({ id, type: 'progress', progress: 8, label: '正在载入本地图像引擎' })
  await ensureOpenCv(id)
  const cv = cvRuntime
  if (!cv) throw new Error('OpenCV 尚未就绪')
  post({ id, type: 'progress', progress: 35, label: '正在分析文档边缘' })
  const { imageData, sourceWidth, sourceHeight } = await blobToImageData(sourceBlob, 1600)
  const source = cv.matFromImageData(imageData)
  try {
    post({ id, type: 'progress', progress: 54, label: '正在比较多种边缘候选' })
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
    post({ id, type: 'progress', progress: 100, label: '边缘识别完成' })
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
  maxEdge: number,
  mimeType: string,
  quality?: number,
) {
  post({ id, type: 'progress', progress: 10, label: '正在读取原图' })
  await ensureOpenCv(id)
  const cv = cvRuntime
  if (!cv) throw new Error('OpenCV 尚未就绪')
  const rendered = await renderPage(cv, page, maxEdge, mimeType, quality, (progress, label) =>
    post({ id, type: 'progress', progress, label }),
  )
  post({ id, type: 'rendered', ...rendered })
}

workerScope.addEventListener('message', (event: MessageEvent<ScannerWorkerRequest>) => {
  const request = event.data
  const task =
    request.type === 'init'
      ? initialize(request.id)
      : request.type === 'detect'
        ? detectDocument(request.id, request.source, request.mode, request.passportLayout)
        : renderDocument(
            request.id,
            request.page,
            request.options.maxEdge,
            request.options.mimeType,
            request.options.quality,
          )

  void task.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '本地图像处理失败'
    post({ id: request.id, type: 'error', message })
  })
})
