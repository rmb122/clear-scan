import type { CV, Mat } from '@techstark/opencv-js'
import { distance, orderPoints } from '@/lib/geometry'
import type { ScanPage } from '@/lib/types'
import { processEffects } from './image-enhancer'
import { blobToImageData } from './worker-image-utils'
function rotateMat(cv: CV, source: Mat, rotation: ScanPage['rotation']) {
  if (rotation === 0) return source.clone()
  const output = new cv.Mat()
  const rotateCode =
    rotation === 90
      ? cv.ROTATE_90_CLOCKWISE
      : rotation === 180
        ? cv.ROTATE_180
        : cv.ROTATE_90_COUNTERCLOCKWISE
  cv.rotate(source, output, rotateCode)
  return output
}

export async function renderPage(
  cv: CV,
  page: ScanPage,
  maxEdge: number,
  mimeType: string,
  quality = 0.92,
  onProgress?: (progress: number, label: string) => void,
) {
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
  let filtered: Mat | undefined

  try {
    onProgress?.(42, '正在校正透视')
    cv.warpPerspective(
      source,
      warped,
      transform,
      new cv.Size(outputWidth, outputHeight),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
    )
    rotated = rotateMat(cv, warped, page.rotation)
    onProgress?.(68, '正在应用增强效果')
    filtered = processEffects(cv, rotated, page.effects, page.adjustments)
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
    source.delete()
    sourceTriangle.delete()
    destinationTriangle.delete()
    transform.delete()
    warped.delete()
    rotated?.delete()
    filtered?.delete()
  }
}
