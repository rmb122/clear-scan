/// <reference lib="webworker" />

import type { CV, Mat } from '@techstark/opencv-js'
import {
  calibrateDetectionConfidence,
  deduplicateCandidates,
  DETECTION_CONFIDENCE_THRESHOLD,
  lineAngleDifference,
  lineIntersection,
  scoreDetectionCandidate,
  suppressNestedCandidates,
  type DetectionCandidate,
  type DetectionCandidateSource,
  type LineEquation,
} from '@/lib/document-detection'
import { clamp, distance, orderPoints } from '@/lib/geometry'
import type {
  DetectionResult,
  EnhancementEffects,
  EnhancementSettings,
  GlareLevel,
  NormalizedQuad,
  PassportLayout,
  Point,
  ScanMode,
  ScanPage,
  ScannerWorkerRequest,
  ScannerWorkerResponse,
} from '@/lib/types'

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

async function blobToImageData(blob: Blob, maxEdge: number) {
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
  })
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('当前浏览器无法创建图像画布')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return {
    imageData: context.getImageData(0, 0, width, height),
    sourceWidth: width,
    sourceHeight: height,
  }
}

function expectedRatio(mode: ScanMode, passportLayout?: PassportLayout) {
  if (mode === 'id-card') return 85.6 / 53.98
  if (mode === 'passport') return passportLayout === 'spread' ? 2.84 : 1.42
  return undefined
}

interface RawDetectionCandidate {
  corners: NormalizedQuad
  source: DetectionCandidateSource
}

interface DetectedLine extends LineEquation {
  start: Point
  end: Point
  midpoint: Point
  angle: number
  length: number
}

function scaledOdd(value: number, minimum: number, maximum: number) {
  let result = Math.round(clamp(value, minimum, maximum))
  if (result % 2 === 0) result += result < maximum ? 1 : -1
  return result
}

function medianIntensity(mat: Mat) {
  const histogram = new Uint32Array(256)
  const step = Math.max(1, Math.floor(mat.data.length / 350_000))
  let samples = 0
  for (let index = 0; index < mat.data.length; index += step) {
    histogram[mat.data[index]] += 1
    samples += 1
  }
  let cumulative = 0
  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value]
    if (cumulative >= samples / 2) return value
  }
  return 128
}

function closeEdgeMap(cv: CV, edges: Mat, kernel: Mat) {
  const closed = new cv.Mat()
  const dilated = new cv.Mat()
  try {
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel)
    cv.dilate(closed, dilated, kernel)
    return dilated.clone()
  } finally {
    closed.delete()
    dilated.delete()
  }
}

function createCannyMap(cv: CV, gray: Mat, kernel: Mat) {
  const blurred = new cv.Mat()
  const edges = new cv.Mat()
  try {
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT)
    const median = medianIntensity(blurred)
    const lower = clamp(median * 0.66, 18, 110)
    const upper = Math.max(lower + 30, clamp(median * 1.33, 70, 240))
    cv.Canny(blurred, edges, lower, upper)
    return closeEdgeMap(cv, edges, kernel)
  } finally {
    blurred.delete()
    edges.delete()
  }
}

function createAdaptiveEdgeMap(cv: CV, gray: Mat, kernel: Mat, inverse: boolean) {
  const thresholded = new cv.Mat()
  const connected = new cv.Mat()
  const edges = new cv.Mat()
  const blockSize = scaledOdd(Math.min(gray.cols, gray.rows) / 24, 31, 81)
  try {
    cv.adaptiveThreshold(
      gray,
      thresholded,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      inverse ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY,
      blockSize,
      7,
    )
    cv.morphologyEx(thresholded, connected, cv.MORPH_CLOSE, kernel)
    cv.Canny(connected, edges, 30, 105)
    return closeEdgeMap(cv, edges, kernel)
  } finally {
    thresholded.delete()
    connected.delete()
    edges.delete()
  }
}

function readQuad(mat: Mat, width: number, height: number) {
  const points: Point[] = []
  for (let index = 0; index < 4; index += 1) {
    points.push({
      x: mat.data32S[index * 2] / width,
      y: mat.data32S[index * 2 + 1] / height,
    })
  }
  return orderPoints(points)
}

function addRawCandidate(
  candidates: RawDetectionCandidate[],
  corners: Point[],
  source: DetectionCandidateSource,
  allowOuterMargin = false,
) {
  if (corners.length !== 4) return
  if (
    allowOuterMargin &&
    corners.some((point) => point.x < -0.06 || point.x > 1.06 || point.y < -0.06 || point.y > 1.06)
  )
    return
  const ordered = orderPoints(corners)
  const unique = new Set(ordered.map((point) => `${point.x.toFixed(4)}:${point.y.toFixed(4)}`))
  if (unique.size === 4) candidates.push({ corners: ordered, source })
}

function collectContourCandidates(cv: CV, edgeMap: Mat, sourceName: DetectionCandidateSource) {
  const hierarchy = new cv.Mat()
  const contours = new cv.MatVector()
  const candidates: RawDetectionCandidate[] = []
  const imageArea = edgeMap.cols * edgeMap.rows
  const epsilons = [0.012, 0.02, 0.035, 0.055]
  try {
    cv.findContours(edgeMap, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index)
      const area = Math.abs(cv.contourArea(contour)) / imageArea
      if (area < 0.055 || area > 0.99) {
        contour.delete()
        continue
      }
      const perimeter = cv.arcLength(contour, true)
      const hull = new cv.Mat()
      try {
        cv.convexHull(contour, hull, false, true)
        for (const epsilon of epsilons) {
          const approximation = new cv.Mat()
          const hullApproximation = new cv.Mat()
          try {
            cv.approxPolyDP(contour, approximation, perimeter * epsilon, true)
            if (approximation.rows === 4 && cv.isContourConvex(approximation)) {
              addRawCandidate(candidates, readQuad(approximation, edgeMap.cols, edgeMap.rows), sourceName)
            }
            const hullPerimeter = cv.arcLength(hull, true)
            cv.approxPolyDP(hull, hullApproximation, hullPerimeter * epsilon, true)
            if (hullApproximation.rows === 4 && cv.isContourConvex(hullApproximation)) {
              addRawCandidate(candidates, readQuad(hullApproximation, edgeMap.cols, edgeMap.rows), sourceName)
            }
          } finally {
            approximation.delete()
            hullApproximation.delete()
          }
        }

        if (typeof cv.minAreaRect === 'function' && typeof cv.boxPoints === 'function') {
          const rectangle = cv.minAreaRect(hull)
          const points = cv.boxPoints(rectangle).map((point) => ({
            x: point.x / edgeMap.cols,
            y: point.y / edgeMap.rows,
          }))
          addRawCandidate(candidates, points, 'min-area-rect')
        }
      } finally {
        hull.delete()
        contour.delete()
      }
    }
    return candidates
  } finally {
    hierarchy.delete()
    contours.delete()
  }
}

function edgeSupport(edgeMap: Mat, corners: NormalizedQuad) {
  const radius = Math.max(1, Math.round(Math.max(edgeMap.cols, edgeMap.rows) / 700))
  let hits = 0
  let samples = 0
  for (let side = 0; side < 4; side += 1) {
    const start = corners[side]
    const end = corners[(side + 1) % 4]
    for (let step = 1; step <= 36; step += 1) {
      const progress = step / 37
      const x = Math.round((start.x + (end.x - start.x) * progress) * (edgeMap.cols - 1))
      const y = Math.round((start.y + (end.y - start.y) * progress) * (edgeMap.rows - 1))
      let found = false
      for (let offsetY = -radius; offsetY <= radius && !found; offsetY += 1) {
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = clamp(x + offsetX, 0, edgeMap.cols - 1)
          const sampleY = clamp(y + offsetY, 0, edgeMap.rows - 1)
          if (edgeMap.data[sampleY * edgeMap.cols + sampleX] > 0) {
            found = true
            break
          }
        }
      }
      samples += 1
      if (found) hits += 1
    }
  }
  return hits / Math.max(1, samples)
}

function boundaryContrast(imageData: ImageData, corners: NormalizedQuad) {
  const { data, width, height } = imageData
  const offset = Math.max(2, Math.min(width, height) * 0.012)
  const luma = (x: number, y: number) => {
    const sampleX = Math.round(clamp(x, 0, width - 1))
    const sampleY = Math.round(clamp(y, 0, height - 1))
    const index = (sampleY * width + sampleX) * 4
    return data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114
  }
  let contrast = 0
  let samples = 0
  const pixels = corners.map((point) => ({
    x: point.x * width,
    y: point.y * height,
  }))
  for (let side = 0; side < 4; side += 1) {
    const start = pixels[side]
    const end = pixels[(side + 1) % 4]
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.max(1, Math.hypot(dx, dy))
    const normal = { x: -dy / length, y: dx / length }
    for (let step = 3; step <= 17; step += 1) {
      const progress = step / 20
      const x = start.x + dx * progress
      const y = start.y + dy * progress
      const inside = luma(x + normal.x * offset, y + normal.y * offset)
      const outside = luma(x - normal.x * offset, y - normal.y * offset)
      contrast += Math.abs(inside - outside)
      samples += 1
    }
  }
  return clamp(contrast / Math.max(1, samples) / 52)
}

function evaluateCandidates(
  candidates: RawDetectionCandidate[],
  edgeMap: Mat,
  imageData: ImageData,
  targetRatio?: number,
) {
  return candidates
    .map((candidate) =>
      scoreDetectionCandidate({
        ...candidate,
        width: edgeMap.cols,
        height: edgeMap.rows,
        edgeSupport: edgeSupport(edgeMap, candidate.corners),
        contrast: boundaryContrast(imageData, candidate.corners),
        targetRatio,
      }),
    )
    .filter((candidate) => candidate.score > 0)
}

function lineFromPoints(start: Point, end: Point): DetectedLine {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.max(0.001, Math.hypot(dx, dy))
  let angle = Math.atan2(dy, dx) % Math.PI
  if (angle < 0) angle += Math.PI
  const a = dy / length
  const b = -dx / length
  return {
    a,
    b,
    c: -(a * start.x + b * start.y),
    start,
    end,
    midpoint: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    angle,
    length,
  }
}

function extractHoughLines(cv: CV, edgeMap: Mat) {
  const output = new cv.Mat()
  const maxEdge = Math.max(edgeMap.cols, edgeMap.rows)
  try {
    cv.HoughLinesP(
      edgeMap,
      output,
      1,
      Math.PI / 180,
      Math.max(45, Math.round(maxEdge * 0.055)),
      maxEdge * 0.2,
      maxEdge * 0.04,
    )
    const lines: DetectedLine[] = []
    for (let index = 0; index + 3 < output.data32S.length; index += 4) {
      const line = lineFromPoints(
        { x: output.data32S[index], y: output.data32S[index + 1] },
        { x: output.data32S[index + 2], y: output.data32S[index + 3] },
      )
      if (line.length >= maxEdge * 0.2) lines.push(line)
    }
    return lines.sort((left, right) => right.length - left.length).slice(0, 48)
  } finally {
    output.delete()
  }
}

function linePairSeparation(left: DetectedLine, right: DetectedLine, normalAngle: number) {
  const normal = { x: -Math.sin(normalAngle), y: Math.cos(normalAngle) }
  return Math.abs((right.midpoint.x - left.midpoint.x) * normal.x + (right.midpoint.y - left.midpoint.y) * normal.y)
}

function collectHoughCandidates(lines: DetectedLine[], width: number, height: number) {
  const candidates: RawDetectionCandidate[] = []
  const tolerance = Math.PI / 8
  const minimumSeparation = Math.min(width, height) * 0.14
  for (const seed of lines.slice(0, 8)) {
    const perpendicular = (seed.angle + Math.PI / 2) % Math.PI
    const firstFamily = lines.filter((line) => lineAngleDifference(line.angle, seed.angle) <= tolerance).slice(0, 7)
    const secondFamily = lines.filter((line) => lineAngleDifference(line.angle, perpendicular) <= tolerance).slice(0, 7)
    for (let first = 0; first < firstFamily.length; first += 1) {
      for (let opposite = first + 1; opposite < firstFamily.length; opposite += 1) {
        if (linePairSeparation(firstFamily[first], firstFamily[opposite], seed.angle) < minimumSeparation) continue
        for (let second = 0; second < secondFamily.length; second += 1) {
          for (let adjacent = second + 1; adjacent < secondFamily.length; adjacent += 1) {
            if (linePairSeparation(secondFamily[second], secondFamily[adjacent], perpendicular) < minimumSeparation)
              continue
            const points = [
              lineIntersection(firstFamily[first], secondFamily[second]),
              lineIntersection(firstFamily[first], secondFamily[adjacent]),
              lineIntersection(firstFamily[opposite], secondFamily[second]),
              lineIntersection(firstFamily[opposite], secondFamily[adjacent]),
            ]
            if (points.some((point) => !point)) continue
            addRawCandidate(
              candidates,
              (points as Point[]).map((point) => ({
                x: point.x / width,
                y: point.y / height,
              })),
              'hough',
              true,
            )
            if (candidates.length >= 160) return candidates
          }
        }
      }
    }
  }
  return candidates
}

function distanceFromLine(point: Point, line: LineEquation) {
  return Math.abs(line.a * point.x + line.b * point.y + line.c) / Math.max(0.001, Math.hypot(line.a, line.b))
}

function refineCandidateWithLines(candidate: DetectionCandidate, lines: DetectedLine[], width: number, height: number) {
  const pixels = candidate.corners.map((point) => ({
    x: point.x * width,
    y: point.y * height,
  }))
  const band = Math.max(width, height) * 0.04
  const selected = pixels.map((start, index) => {
    const end = pixels[(index + 1) % 4]
    const original = lineFromPoints(start, end)
    return (
      lines
        .filter(
          (line) =>
            lineAngleDifference(line.angle, original.angle) < Math.PI / 15 &&
            distanceFromLine(line.midpoint, original) < band,
        )
        .sort(
          (left, right) =>
            right.length / (1 + distanceFromLine(right.midpoint, original)) -
            left.length / (1 + distanceFromLine(left.midpoint, original)),
        )[0] ?? original
    )
  })
  const refined = [
    lineIntersection(selected[3], selected[0]),
    lineIntersection(selected[0], selected[1]),
    lineIntersection(selected[1], selected[2]),
    lineIntersection(selected[2], selected[3]),
  ]
  if (refined.some((point) => !point)) return undefined
  const normalized = (refined as Point[]).map((point) => ({
    x: point.x / width,
    y: point.y / height,
  }))
  if (normalized.some((point) => point.x < -0.04 || point.x > 1.04 || point.y < -0.04 || point.y > 1.04))
    return undefined
  return orderPoints(normalized)
}

function findDocumentQuad(
  cv: CV,
  source: Mat,
  imageData: ImageData,
  mode: ScanMode,
  passportLayout?: PassportLayout,
  requestId?: string,
) {
  const gray = new cv.Mat()
  const enhanced = new cv.Mat()
  const illumination = new cv.Mat()
  const normalized = new cv.Mat()
  const kernelSize = scaledOdd(Math.min(source.cols, source.rows) / 220, 3, 9)
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kernelSize, kernelSize))
  const edgeMaps: Array<{ mat: Mat; source: DetectionCandidateSource }> = []
  let combined: Mat | undefined

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8))
    try {
      clahe.apply(gray, enhanced)
    } finally {
      clahe.delete()
    }
    const illuminationKernel = scaledOdd(Math.min(source.cols, source.rows) / 12, 31, 101)
    cv.GaussianBlur(enhanced, illumination, new cv.Size(illuminationKernel, illuminationKernel), 0)
    cv.addWeighted(enhanced, 1, illumination, -1, 128, normalized)

    edgeMaps.push(
      { mat: createCannyMap(cv, gray, kernel), source: 'canny' },
      {
        mat: createCannyMap(cv, normalized, kernel),
        source: 'normalized-canny',
      },
      {
        mat: createAdaptiveEdgeMap(cv, enhanced, kernel, false),
        source: 'adaptive-light',
      },
      {
        mat: createAdaptiveEdgeMap(cv, enhanced, kernel, true),
        source: 'adaptive-dark',
      },
    )
    combined = cv.Mat.zeros(source.rows, source.cols, cv.CV_8UC1)
    for (const edgeMap of edgeMaps) cv.bitwise_or(combined, edgeMap.mat, combined)

    if (requestId)
      post({
        id: requestId,
        type: 'progress',
        progress: 68,
        label: '正在评分轮廓候选',
      })
    const rawCandidates = edgeMaps.flatMap((edgeMap) => collectContourCandidates(cv, edgeMap.mat, edgeMap.source))
    const targetRatio = expectedRatio(mode, passportLayout)
    let evaluatedCandidates = evaluateCandidates(rawCandidates, combined, imageData, targetRatio)
    let candidates = suppressNestedCandidates(deduplicateCandidates(evaluatedCandidates, source.cols, source.rows))
    if (requestId)
      post({
        id: requestId,
        type: 'progress',
        progress: 82,
        label: '正在补全缺失边线',
      })
    const houghLines = extractHoughLines(cv, combined)
    const initialConfidence = calibrateDetectionConfidence(candidates[0], candidates[1])
    if (!candidates[0] || candidates[0].score < 0.74 || initialConfidence < 0.72) {
      evaluatedCandidates = [
        ...evaluatedCandidates,
        ...evaluateCandidates(
          collectHoughCandidates(houghLines, source.cols, source.rows),
          combined,
          imageData,
          targetRatio,
        ),
      ]
      candidates = suppressNestedCandidates(deduplicateCandidates(evaluatedCandidates, source.cols, source.rows))
    }

    const best = candidates[0]
    if (best) {
      if (requestId)
        post({
          id: requestId,
          type: 'progress',
          progress: 91,
          label: '正在精修文档四角',
        })
      const refinedCorners = refineCandidateWithLines(best, houghLines, source.cols, source.rows)
      if (refinedCorners) {
        const refined = evaluateCandidates(
          [{ corners: refinedCorners, source: best.source }],
          combined,
          imageData,
          targetRatio,
        )[0]
        if (refined && refined.score >= best.score - 0.015 && refined.edgeSupport >= best.edgeSupport - 0.04) {
          evaluatedCandidates = [refined, ...evaluatedCandidates]
          candidates = suppressNestedCandidates(deduplicateCandidates(evaluatedCandidates, source.cols, source.rows))
        }
      }
    }

    return {
      best: candidates[0],
      confidence: calibrateDetectionConfidence(candidates[0], candidates[1]),
    }
  } finally {
    gray.delete()
    enhanced.delete()
    illumination.delete()
    normalized.delete()
    edgeMaps.forEach((edgeMap) => edgeMap.mat.delete())
    combined?.delete()
    kernel.delete()
  }
}

function detectGlare(cv: CV, source: Mat): GlareLevel {
  const highlight = recoverableHighlightMask(cv, source)
  let glare = 0
  for (const value of highlight.data) glare += value
  const ratio = glare / Math.max(1, highlight.data.length)
  if (ratio > 0.012) return 'severe'
  if (ratio > 0.002) return 'mild'
  return 'none'
}

async function detectDocument(id: string, sourceBlob: Blob, mode: ScanMode, passportLayout?: PassportLayout) {
  post({ id, type: 'progress', progress: 8, label: '正在载入本地图像引擎' })
  await ensureOpenCv(id)
  const cv = cvRuntime
  if (!cv) throw new Error('OpenCV 尚未就绪')
  post({ id, type: 'progress', progress: 35, label: '正在分析文档边缘' })
  const { imageData, sourceWidth, sourceHeight } = await blobToImageData(sourceBlob, 1600)
  const source = cv.matFromImageData(imageData)
  try {
    post({ id, type: 'progress', progress: 54, label: '正在比较多种边缘候选' })
    const detection = findDocumentQuad(cv, source, imageData, mode, passportLayout, id)
    const accepted = Boolean(detection.best && detection.confidence >= DETECTION_CONFIDENCE_THRESHOLD)
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

function rotateMat(cv: CV, source: Mat, rotation: ScanPage['rotation']) {
  if (rotation === 0) return source.clone()
  const output = new cv.Mat()
  const rotateCode =
    rotation === 90 ? cv.ROTATE_90_CLOCKWISE : rotation === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE
  cv.rotate(source, output, rotateCode)
  return output
}

function applyToneAdjustments(mat: Mat, adjustments: EnhancementSettings) {
  const data = mat.data
  const contrast = 1 + adjustments.contrast / 100
  const brightness = adjustments.brightness

  for (let index = 0; index < data.length; index += 4) {
    data[index] = clamp((data[index] - 128) * contrast + 128 + brightness, 0, 255)
    data[index + 1] = clamp((data[index + 1] - 128) * contrast + 128 + brightness, 0, 255)
    data[index + 2] = clamp((data[index + 2] - 128) * contrast + 128 + brightness, 0, 255)
  }
}

function mix(left: number, right: number, amount: number) {
  return left + (right - left) * clamp(amount, 0, 1)
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1
  const normalized = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return normalized * normalized * (3 - 2 * normalized)
}

function pixelLuma(red: number, green: number, blue: number) {
  return red * 0.299 + green * 0.587 + blue * 0.114
}

function recoverableHighlightMask(cv: CV, source: Mat) {
  const analysis = new cv.Mat()
  try {
    const scale = Math.min(1, 640 / Math.max(source.cols, source.rows))
    const width = Math.max(1, Math.round(source.cols * scale))
    const height = Math.max(1, Math.round(source.rows * scale))
    cv.resize(source, analysis, new cv.Size(width, height), 0, 0, cv.INTER_AREA)
    const candidate = new Uint8Array(width * height)
    for (let pixel = 0, index = 0; pixel < candidate.length; pixel += 1, index += 4) {
      const red = analysis.data[index]
      const green = analysis.data[index + 1]
      const blue = analysis.data[index + 2]
      const light = pixelLuma(red, green, blue)
      const saturation = Math.max(red, green, blue) - Math.min(red, green, blue)
      candidate[pixel] = light >= 194 && saturation <= 86 ? 1 : 0
    }
    // A bright page is normally connected to the crop boundary. Excluding that
    // component prevents paper margins from being pulled toward nearby ink.
    const exterior = new Uint8Array(candidate.length)
    const queue = new Int32Array(candidate.length)
    let head = 0
    let tail = 0
    const enqueue = (pixel: number) => {
      if (!candidate[pixel] || exterior[pixel]) return
      exterior[pixel] = 1
      queue[tail] = pixel
      tail += 1
    }
    for (let x = 0; x < width; x += 1) {
      enqueue(x)
      enqueue((height - 1) * width + x)
    }
    for (let y = 1; y < height - 1; y += 1) {
      enqueue(y * width)
      enqueue(y * width + width - 1)
    }
    while (head < tail) {
      const pixel = queue[head]
      head += 1
      const x = pixel % width
      if (x > 0) enqueue(pixel - 1)
      if (x + 1 < width) enqueue(pixel + 1)
      if (pixel >= width) enqueue(pixel - width)
      if (pixel + width < candidate.length) enqueue(pixel + width)
      if (x > 0 && pixel >= width) enqueue(pixel - width - 1)
      if (x + 1 < width && pixel >= width) enqueue(pixel - width + 1)
      if (x > 0 && pixel + width < candidate.length) enqueue(pixel + width - 1)
      if (x + 1 < width && pixel + width < candidate.length) enqueue(pixel + width + 1)
    }

    // Only broad, graduated highlight blobs are recoverable glare. Connected
    // component geometry and tone spread protect legitimate white text, logos,
    // barcodes and solid design elements inside coloured regions.
    const recoverable = new Uint8Array(candidate.length)
    const minimumArea = Math.max(32, Math.round(candidate.length * 0.00025))
    const maximumArea = Math.round(candidate.length * 0.12)
    const minimumSpan = Math.max(6, Math.round(Math.min(width, height) * 0.018))
    for (let start = 0; start < candidate.length; start += 1) {
      if (!candidate[start] || exterior[start]) continue
      head = 0
      tail = 0
      candidate[start] = 0
      queue[tail] = start
      tail += 1
      let minX = width
      let maxX = 0
      let minY = height
      let maxY = 0
      let sum = 0
      let sumSquares = 0
      let minimumLight = 255
      let maximumLight = 0
      let shoulderPixels = 0

      const enqueueComponent = (pixel: number) => {
        if (!candidate[pixel] || exterior[pixel]) return
        candidate[pixel] = 0
        queue[tail] = pixel
        tail += 1
      }
      while (head < tail) {
        const pixel = queue[head]
        head += 1
        const x = pixel % width
        const y = Math.floor(pixel / width)
        const index = pixel * 4
        const light = pixelLuma(analysis.data[index], analysis.data[index + 1], analysis.data[index + 2])
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
        sum += light
        sumSquares += light * light
        minimumLight = Math.min(minimumLight, light)
        maximumLight = Math.max(maximumLight, light)
        if (light >= 202 && light <= 240) shoulderPixels += 1

        if (x > 0) enqueueComponent(pixel - 1)
        if (x + 1 < width) enqueueComponent(pixel + 1)
        if (pixel >= width) enqueueComponent(pixel - width)
        if (pixel + width < candidate.length) enqueueComponent(pixel + width)
        if (x > 0 && pixel >= width) enqueueComponent(pixel - width - 1)
        if (x + 1 < width && pixel >= width) enqueueComponent(pixel - width + 1)
        if (x > 0 && pixel + width < candidate.length) enqueueComponent(pixel + width - 1)
        if (x + 1 < width && pixel + width < candidate.length) enqueueComponent(pixel + width + 1)
      }

      const area = tail
      const boxWidth = maxX - minX + 1
      const boxHeight = maxY - minY + 1
      const aspectRatio = Math.max(boxWidth / boxHeight, boxHeight / boxWidth)
      const fillRatio = area / (boxWidth * boxHeight)
      const average = sum / area
      const deviation = Math.sqrt(Math.max(0, sumSquares / area - average * average))
      const isGraduatedBlob =
        area >= minimumArea &&
        area <= maximumArea &&
        Math.min(boxWidth, boxHeight) >= minimumSpan &&
        aspectRatio <= 12 &&
        fillRatio >= 0.2 &&
        maximumLight >= 245 &&
        maximumLight - minimumLight >= 28 &&
        deviation >= 7 &&
        shoulderPixels / area >= 0.18
      if (!isGraduatedBlob) continue
      for (let index = 0; index < tail; index += 1) recoverable[queue[index]] = 1
    }
    return { data: recoverable, width, height }
  } finally {
    analysis.delete()
  }
}

function applyGlareReduction(cv: CV, source: Mat) {
  const background = new cv.Mat()
  try {
    // Glare can be much wider than a text line. A large colour-aware background
    // estimate lets us reconstruct both luminance and local paper/ink chroma.
    const kernelSize = scaledOdd(Math.min(source.cols, source.rows) / 5, 61, 201)
    cv.GaussianBlur(source, background, new cv.Size(kernelSize, kernelSize), 0)
    const highlight = recoverableHighlightMask(cv, source)
    const pixels = source.data
    for (let y = 0; y < source.rows; y += 1) {
      const maskY = Math.min(highlight.height - 1, Math.floor((y * highlight.height) / source.rows))
      for (let x = 0; x < source.cols; x += 1) {
        const maskX = Math.min(highlight.width - 1, Math.floor((x * highlight.width) / source.cols))
        if (!highlight.data[maskY * highlight.width + maskX]) continue
        const index = (y * source.cols + x) * 4
        const red = pixels[index]
        const green = pixels[index + 1]
        const blue = pixels[index + 2]
        const light = pixelLuma(red, green, blue)
        const localRed = background.data[index]
        const localGreen = background.data[index + 1]
        const localBlue = background.data[index + 2]
        const localLight = pixelLuma(localRed, localGreen, localBlue)
        const saturation = Math.max(red, green, blue) - Math.min(red, green, blue)
        const excess = light - localLight
        const strength = smoothstep(198, 244, light) * smoothstep(4, 38, excess) * (1 - smoothstep(28, 82, saturation))
        if (strength < 0.01) continue
        const targetLight = localLight + Math.min(7, Math.max(0, excess) * 0.12)
        const reconstructedRed = targetLight + (localRed - localLight) * 1.18
        const reconstructedGreen = targetLight + (localGreen - localLight) * 1.18
        const reconstructedBlue = targetLight + (localBlue - localLight) * 1.18
        const blend = strength * 0.94
        pixels[index] = clamp(mix(red, reconstructedRed, blend), 0, 255)
        pixels[index + 1] = clamp(mix(green, reconstructedGreen, blend), 0, 255)
        pixels[index + 2] = clamp(mix(blue, reconstructedBlue, blend), 0, 255)
      }
    }
  } finally {
    background.delete()
  }
}

function percentile(data: Uint8Array, fraction: number) {
  const histogram = new Uint32Array(256)
  const step = Math.max(1, Math.floor(data.length / 500_000))
  let count = 0
  for (let index = 0; index < data.length; index += step) {
    histogram[data[index]] += 1
    count += 1
  }
  const target = count * fraction
  let total = 0
  for (let value = 0; value < 256; value += 1) {
    total += histogram[value]
    if (total >= target) return value
  }
  return 255
}

function histogramPercentile(histogram: Uint32Array, count: number, fraction: number) {
  const target = count * fraction
  let total = 0
  for (let value = 0; value < histogram.length; value += 1) {
    total += histogram[value]
    if (total >= target) return value
  }
  return histogram.length - 1
}

function estimatePaperWhitePoint(data: Uint8Array) {
  const histogram = new Uint32Array(256)
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    histogram[Math.round(pixelLuma(data[index], data[index + 1], data[index + 2]))] += 1
    count += 1
  }
  const lower = histogramPercentile(histogram, count, 0.62)
  const upper = histogramPercentile(histogram, count, 0.95)
  let red = 0
  let green = 0
  let blue = 0
  let samples = 0
  for (let index = 0; index < data.length; index += 4) {
    const r = data[index]
    const g = data[index + 1]
    const b = data[index + 2]
    const light = pixelLuma(r, g, b)
    const saturation = Math.max(r, g, b) - Math.min(r, g, b)
    if (light < lower || light > upper || saturation > 72) continue
    red += r
    green += g
    blue += b
    samples += 1
  }
  if (!samples) return { red: upper, green: upper, blue: upper, luma: upper }
  const result = {
    red: red / samples,
    green: green / samples,
    blue: blue / samples,
    luma: 0,
  }
  result.luma = pixelLuma(result.red, result.green, result.blue)
  return result
}

function balancedLumaHistogram(data: Uint8Array, redScale: number, greenScale: number, blueScale: number) {
  const histogram = new Uint32Array(256)
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    const light = pixelLuma(
      clamp(data[index] * redScale, 0, 255),
      clamp(data[index + 1] * greenScale, 0, 255),
      clamp(data[index + 2] * blueScale, 0, 255),
    )
    histogram[Math.round(light)] += 1
    count += 1
  }
  return { histogram, count }
}

/** Estimate the light falling on the page while closing over text and fine graphics. */
function estimatePaperIllumination(cv: CV, source: Mat) {
  const gray = new cv.Mat()
  const analysis = new cv.Mat()
  const smooth = new cv.Mat()
  const full = new cv.Mat()
  const closes: Mat[] = []
  const kernels: Mat[] = []
  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    // Illumination is deliberately estimated at a small scale: shadows are
    // low-frequency and rectangular morphology is separable in OpenCV/WASM.
    const scale = Math.min(1, 360 / Math.max(gray.cols, gray.rows))
    const width = Math.max(1, Math.round(gray.cols * scale))
    const height = Math.max(1, Math.round(gray.rows * scale))
    cv.resize(gray, analysis, new cv.Size(width, height), 0, 0, cv.INTER_AREA)
    const shortSide = Math.min(width, height)
    const ratios = [0.04, 0.12, 0.26]
    for (const ratio of ratios) {
      const size = scaledOdd(shortSide * ratio, 7, 101)
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(size, size))
      const closed = new cv.Mat()
      cv.morphologyEx(analysis, closed, cv.MORPH_CLOSE, kernel)
      kernels.push(kernel)
      closes.push(closed)
    }
    const combined = closes[0].clone()
    for (let index = 0; index < combined.data.length; index += 1) {
      // The large scale bridges broad cast shadows; the smaller scales reduce edge halos.
      combined.data[index] = Math.max(closes[0].data[index] * 0.94, closes[1].data[index] * 0.98, closes[2].data[index])
    }
    const blurSize = scaledOdd(shortSide / 22, 9, 41)
    cv.GaussianBlur(combined, smooth, new cv.Size(blurSize, blurSize), 0)
    cv.resize(smooth, full, new cv.Size(source.cols, source.rows), 0, 0, cv.INTER_CUBIC)
    combined.delete()
    return full.clone()
  } finally {
    gray.delete()
    analysis.delete()
    smooth.delete()
    full.delete()
    closes.forEach((mat) => mat.delete())
    kernels.forEach((mat) => mat.delete())
  }
}

function applyClassicalShadowRemoval(cv: CV, source: Mat, shadowStrength: number) {
  const illumination = estimatePaperIllumination(cv, source)
  const gray = new cv.Mat()
  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    const dark = percentile(illumination.data, 0.12)
    const paper = percentile(illumination.data, 0.92)
    const variation = paper - dark
    // A flat page should remain flat. This prevents needless colour and exposure shifts.
    if (variation < 4) return
    const normalizedStrength = clamp(shadowStrength, 0, 100) / 100
    const blend = clamp(0.3 + Math.sqrt(normalizedStrength) * 0.77, 0, 1)
    const target = Math.max(paper, percentile(gray.data, 0.9), variation > 22 && paper < 184 ? 184 : paper)
    const pixels = source.data
    for (let pixel = 0, index = 0; pixel < illumination.data.length; pixel += 1, index += 4) {
      const background = Math.max(36, illumination.data[pixel])
      // Blend toward direct shade normalization. Applying the ratio from the
      // low-frequency illumination map preserves local ink contrast while
      // flattening broad gradients and cast shadows.
      const ratio = clamp(target / background, 1, 2.4)
      const gain = 1 + (ratio - 1) * blend
      pixels[index] = clamp(pixels[index] * gain, 0, 255)
      pixels[index + 1] = clamp(pixels[index + 1] * gain, 0, 255)
      pixels[index + 2] = clamp(pixels[index + 2] * gain, 0, 255)
    }
  } finally {
    illumination.delete()
    gray.delete()
  }
}

function applyDocumentColorEnhancement(cv: CV, output: Mat, flattenPaper: boolean) {
  // Market-style colour modes clean the paper as well as boosting coloured ink.
  // They perform their own base flattening only when the shadow category is off;
  // otherwise they consume that category's standard or AI result without stacking it.
  if (flattenPaper) applyClassicalShadowRemoval(cv, output, 90)
  const data = output.data
  const whitePoint = estimatePaperWhitePoint(data)
  const redScale = clamp(whitePoint.luma / Math.max(1, whitePoint.red), 0.84, 1.2)
  const greenScale = clamp(whitePoint.luma / Math.max(1, whitePoint.green), 0.84, 1.2)
  const blueScale = clamp(whitePoint.luma / Math.max(1, whitePoint.blue), 0.84, 1.2)
  const { histogram, count } = balancedLumaHistogram(data, redScale, greenScale, blueScale)
  const blackPoint = histogramPercentile(histogram, count, 0.015)
  const paperPoint = Math.max(blackPoint + 48, histogramPercentile(histogram, count, 0.86))
  const range = paperPoint - blackPoint

  for (let index = 0; index < data.length; index += 4) {
    const red = clamp(data[index] * redScale, 0, 255)
    const green = clamp(data[index + 1] * greenScale, 0, 255)
    const blue = clamp(data[index + 2] * blueScale, 0, 255)
    const light = pixelLuma(red, green, blue)
    const normalized = clamp((light - blackPoint) / range, 0, 1)
    const saturation = Math.max(red, green, blue) - Math.min(red, green, blue)
    const paperMask = smoothstep(0.76, 0.98, normalized) * (1 - smoothstep(20, 74, saturation))
    let targetLight = 8 + 240 * normalized ** 0.8
    targetLight = mix(targetLight, 248, paperMask * 0.88)
    const chromaScale = mix(1.17, 0.08, paperMask)
    data[index] = clamp(targetLight + (red - light) * chromaScale, 0, 255)
    data[index + 1] = clamp(targetLight + (green - light) * chromaScale, 0, 255)
    data[index + 2] = clamp(targetLight + (blue - light) * chromaScale, 0, 255)
  }
}

function applyGrayscaleDocument(cv: CV, output: Mat, flattenPaper: boolean) {
  const gray = new cv.Mat()
  const denoised = new cv.Mat()
  try {
    if (flattenPaper) applyClassicalShadowRemoval(cv, output, 92)
    cv.cvtColor(output, gray, cv.COLOR_RGBA2GRAY)
    cv.bilateralFilter(gray, denoised, 5, 22, 4)
    const blackPoint = percentile(denoised.data, 0.018)
    const paperPoint = Math.max(blackPoint + 48, percentile(denoised.data, 0.86))
    const range = paperPoint - blackPoint
    for (let index = 0; index < denoised.data.length; index += 1) {
      const normalized = clamp((denoised.data[index] - blackPoint) / range, 0, 1)
      denoised.data[index] = clamp(6 + 243 * normalized ** 0.82, 0, 255)
    }
    cv.cvtColor(denoised, output, cv.COLOR_GRAY2RGBA)
  } finally {
    gray.delete()
    denoised.delete()
  }
}

function applyBlackWhiteDocument(cv: CV, output: Mat, flattenPaper: boolean) {
  const gray = new cv.Mat()
  const denoised = new cv.Mat()
  const normalized = new cv.Mat()
  const adaptive = new cv.Mat()
  try {
    if (flattenPaper) applyClassicalShadowRemoval(cv, output, 100)
    cv.cvtColor(output, gray, cv.COLOR_RGBA2GRAY)
    cv.bilateralFilter(gray, denoised, 5, 24, 4)
    normalized.create(denoised.rows, denoised.cols, cv.CV_8UC1)
    const blackPoint = percentile(denoised.data, 0.012)
    const paperPoint = Math.max(blackPoint + 52, percentile(denoised.data, 0.86))
    const range = paperPoint - blackPoint
    for (let index = 0; index < denoised.data.length; index += 1) {
      const value = clamp((denoised.data[index] - blackPoint) / range, 0, 1)
      normalized.data[index] = clamp(5 + 248 * value ** 0.88, 0, 255)
    }
    const blockSize = scaledOdd(Math.min(output.cols, output.rows) / 14, 41, 121)
    cv.adaptiveThreshold(normalized, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, 12)
    // Adaptive thresholding alone treats a large uniform red stamp as paper.
    // Combine it with the normalized global tone so coloured document content
    // remains visible while faint background texture stays white.
    for (let index = 0; index < adaptive.data.length; index += 1) {
      const value = normalized.data[index]
      adaptive.data[index] = value < 194 || (adaptive.data[index] === 0 && value < 234) ? 0 : 255
    }
    cv.cvtColor(adaptive, output, cv.COLOR_GRAY2RGBA)
  } finally {
    gray.delete()
    denoised.delete()
    normalized.delete()
    adaptive.delete()
  }
}

function applyColorEffect(cv: CV, output: Mat, effect: EnhancementEffects['color'], flattenPaper: boolean) {
  if (effect === 'enhanced-color') {
    applyDocumentColorEnhancement(cv, output, flattenPaper)
  } else if (effect === 'grayscale') {
    applyGrayscaleDocument(cv, output, flattenPaper)
  } else if (effect === 'black-white') {
    applyBlackWhiteDocument(cv, output, flattenPaper)
  }
}

function applyDetailEnhancement(cv: CV, output: Mat, strength: number) {
  const amount = 0.28 + (clamp(strength, 0, 100) / 100) * 0.92
  const blur = new cv.Mat()
  try {
    cv.GaussianBlur(output, blur, new cv.Size(0, 0), 0.9)
    const pixels = output.data
    const blurred = blur.data
    for (let index = 0; index < pixels.length; index += 4) {
      const light = pixelLuma(pixels[index], pixels[index + 1], pixels[index + 2])
      const blurredLight = pixelLuma(blurred[index], blurred[index + 1], blurred[index + 2])
      const edgeMask = smoothstep(1.6, 13, Math.abs(light - blurredLight))
      if (edgeMask < 0.01) continue
      for (let channel = 0; channel < 3; channel += 1) {
        const detail = clamp(pixels[index + channel] - blurred[index + channel], -16, 16)
        pixels[index + channel] = clamp(pixels[index + channel] + detail * amount * edgeMask, 0, 255)
      }
    }
  } finally {
    blur.delete()
  }
}

function processEffects(cv: CV, source: Mat, effects: EnhancementEffects, adjustments: EnhancementSettings) {
  const output = source.clone()
  try {
    if (effects.shadow === 'deshadow') {
      applyClassicalShadowRemoval(cv, output, adjustments.shadowStrength)
    }
    if (effects.glare === 'deglare') {
      applyGlareReduction(cv, output)
    }
    applyToneAdjustments(output, adjustments)
    applyColorEffect(cv, output, effects.color, effects.shadow === 'none')
    if (effects.detail === 'sharpen') {
      applyDetailEnhancement(cv, output, adjustments.sharpness)
    }
    return output
  } catch (error) {
    output.delete()
    throw error
  }
}

async function renderPage(id: string, page: ScanPage, maxEdge: number, mimeType: string, quality = 0.92) {
  post({ id, type: 'progress', progress: 10, label: '正在读取原图' })
  await ensureOpenCv(id)
  const cv = cvRuntime
  if (!cv) throw new Error('OpenCV 尚未就绪')
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
    post({ id, type: 'progress', progress: 42, label: '正在校正透视' })
    cv.warpPerspective(
      source,
      warped,
      transform,
      new cv.Size(outputWidth, outputHeight),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
    )
    rotated = rotateMat(cv, warped, page.rotation)
    post({ id, type: 'progress', progress: 68, label: '正在应用增强效果' })
    filtered = processEffects(cv, rotated, page.effects, page.adjustments)
    const canvas = new OffscreenCanvas(filtered.cols, filtered.rows)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法生成扫描结果')
    const pixels = new Uint8ClampedArray(filtered.data)
    context.putImageData(new ImageData(pixels, filtered.cols, filtered.rows), 0, 0)
    const blob = await canvas.convertToBlob({ type: mimeType, quality })
    post({ id, type: 'progress', progress: 100, label: '处理完成' })
    post({
      id,
      type: 'rendered',
      blob,
      width: filtered.cols,
      height: filtered.rows,
    })
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

workerScope.addEventListener('message', (event: MessageEvent<ScannerWorkerRequest>) => {
  const request = event.data
  const task =
    request.type === 'detect'
      ? detectDocument(request.id, request.source, request.mode, request.passportLayout)
      : renderPage(request.id, request.page, request.options.maxEdge, request.options.mimeType, request.options.quality)

  void task.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '本地图像处理失败'
    post({ id: request.id, type: 'error', message })
  })
})
