import type { CV, Mat } from '@techstark/opencv-js'
import { distance, orderPoints } from '@/lib/geometry'
import type { ScanPage } from '@/lib/types'
import { createLightingResult, processEffects, processEffectsFromLighting } from './image-enhancer'
import { blobToImageData } from './worker-image-utils'

const MAX_CACHED_MAT_BYTES = 8 * 1024 * 1024

interface PreviewPipelineCache {
  pageId: string
  baseKey: string
  base: Mat
  lightingKey?: string
  lighting?: Mat
}

let previewCache: PreviewPipelineCache | undefined

function rotateMat(cv: CV, source: Mat, rotation: ScanPage['rotation']) {
  const output = new cv.Mat()
  if (rotation === 0) {
    source.copyTo(output)
    return output
  }
  const rotateCode =
    rotation === 90
      ? cv.ROTATE_90_CLOCKWISE
      : rotation === 180
        ? cv.ROTATE_180
        : cv.ROTATE_90_COUNTERCLOCKWISE
  cv.rotate(source, output, rotateCode)
  return output
}

function createBaseKey(page: ScanPage, maxEdge: number) {
  return JSON.stringify([
    page.id,
    page.createdAt,
    page.sourceName,
    page.source.size,
    page.source.type,
    page.corners.flatMap((point) => [point.x, point.y]),
    page.rotation,
    maxEdge,
  ])
}

function createLightingKey(page: ScanPage, baseKey: string) {
  return JSON.stringify([
    baseKey,
    page.effects.shadow,
    page.effects.glare,
    page.adjustments.shadowStrength,
  ])
}

function clearPreviewCache() {
  previewCache?.lighting?.delete()
  previewCache?.base.delete()
  previewCache = undefined
}

export function clearRenderPipelineCache(pageId?: string) {
  if (pageId && previewCache?.pageId !== pageId) return
  clearPreviewCache()
}

function cacheBase(pageId: string, baseKey: string, base: Mat) {
  clearPreviewCache()
  if (base.data.byteLength > MAX_CACHED_MAT_BYTES) return false
  previewCache = { pageId, baseKey, base }
  return true
}

function cacheLighting(lightingKey: string, lighting: Mat) {
  if (!previewCache || lighting.data.byteLength > MAX_CACHED_MAT_BYTES) return false
  previewCache.lighting?.delete()
  previewCache.lightingKey = lightingKey
  previewCache.lighting = lighting
  return true
}

async function preparePageBase(cv: CV, page: ScanPage, maxEdge: number) {
  const { imageData, sourceWidth, sourceHeight } = await blobToImageData(page.source, maxEdge * 1.4)
  const source = cv.matFromImageData(imageData)
  const sourcePoints = orderPoints(page.corners).map((point) => ({
    x: point.x * sourceWidth,
    y: point.y * sourceHeight,
  }))
  const topWidth = distance(sourcePoints[0], sourcePoints[1])
  const bottomWidth = distance(sourcePoints[3], sourcePoints[2])
  const leftHeight = distance(sourcePoints[0], sourcePoints[3])
  const rightHeight = distance(sourcePoints[1], sourcePoints[2])
  let outputWidth = Math.max(1, Math.round(Math.max(topWidth, bottomWidth)))
  let outputHeight = Math.max(1, Math.round(Math.max(leftHeight, rightHeight)))
  const outputScale = Math.min(1, maxEdge / Math.max(outputWidth, outputHeight))
  outputWidth = Math.max(1, Math.round(outputWidth * outputScale))
  outputHeight = Math.max(1, Math.round(outputHeight * outputScale))

  const sourceTriangle = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    sourcePoints.flatMap((point) => [point.x, point.y]),
  )
  const destinationTriangle = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0,
    0,
    outputWidth - 1,
    0,
    outputWidth - 1,
    outputHeight - 1,
    0,
    outputHeight - 1,
  ])
  const transform = cv.getPerspectiveTransform(sourceTriangle, destinationTriangle)
  const warped = new cv.Mat()
  let rotated: Mat | undefined

  try {
    cv.warpPerspective(
      source,
      warped,
      transform,
      new cv.Size(outputWidth, outputHeight),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
    )
    rotated = rotateMat(cv, warped, page.rotation)
    return rotated
  } catch (error) {
    rotated?.delete()
    throw error
  } finally {
    source.delete()
    sourceTriangle.delete()
    destinationTriangle.delete()
    transform.delete()
    warped.delete()
  }
}

export async function renderPage(
  cv: CV,
  page: ScanPage,
  maxEdge: number,
  mimeType: string,
  quality = 0.92,
  cacheIntermediate = false,
  onProgress?: (progress: number, label: string) => void,
) {
  const baseKey = createBaseKey(page, maxEdge)
  let base = cacheIntermediate && previewCache?.baseKey === baseKey ? previewCache.base : undefined
  let ownsBase = false

  onProgress?.(42, '正在校正透视')
  if (!base) {
    base = await preparePageBase(cv, page, maxEdge)
    if (!cacheIntermediate || !cacheBase(page.id, baseKey, base)) ownsBase = true
  }

  let filtered: Mat | undefined
  try {
    onProgress?.(68, '正在应用增强效果')
    if (!cacheIntermediate || previewCache?.base !== base) {
      filtered = processEffects(cv, base, page.effects, page.adjustments)
    } else {
      const hasLighting = page.effects.shadow !== 'none' || page.effects.glare !== 'none'
      if (!hasLighting) {
        filtered = processEffectsFromLighting(cv, base, page.effects, page.adjustments)
      } else {
        const lightingKey = createLightingKey(page, baseKey)
        let lighting = previewCache.lightingKey === lightingKey ? previewCache.lighting : undefined
        if (!lighting) {
          lighting = createLightingResult(cv, base, page.effects, page.adjustments)
          if (!cacheLighting(lightingKey, lighting)) {
            try {
              filtered = processEffectsFromLighting(cv, lighting, page.effects, page.adjustments)
            } finally {
              lighting.delete()
            }
          }
        }
        filtered ??= processEffectsFromLighting(cv, lighting, page.effects, page.adjustments)
      }
    }

    const canvas = new OffscreenCanvas(filtered.cols, filtered.rows)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法生成扫描结果')
    const pixels = new Uint8ClampedArray(
      filtered.data.buffer as ArrayBuffer,
      filtered.data.byteOffset,
      filtered.data.byteLength,
    )
    context.putImageData(new ImageData(pixels, filtered.cols, filtered.rows), 0, 0)
    const blob = await canvas.convertToBlob({ type: mimeType, quality })
    onProgress?.(100, '处理完成')
    return { blob, width: filtered.cols, height: filtered.rows }
  } finally {
    if (ownsBase) base.delete()
    filtered?.delete()
  }
}
