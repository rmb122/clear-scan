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
  AdvancedCorrection,
  AdvancedModelBackend,
  DetectionResult,
  EnhancementSettings,
  FilterPreset,
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
let advancedSession: import('onnxruntime-web').InferenceSession | undefined
let advancedOrt: typeof import('onnxruntime-web') | undefined
let advancedBackend: AdvancedModelBackend | undefined
let advancedInputSize: 256 | 384 | 512 = 256
let advancedBenchmarkMs = 0

const ADVANCED_MODEL_ID = 'docshadow-sd7k-fp16'
const ADVANCED_MODEL_VERSION = '1.0.0-fp16'

function post(message: ScannerWorkerResponse) {
  workerScope.postMessage(message)
}

function ensureOpenCv(requestId: string) {
  if (!cvReadyPromise) {
    cvReadyPromise = (async () => {
      const candidate = workerScope.cv as CV | Promise<CV>
      if (!candidate) throw new Error('OpenCV 本地图像引擎载入失败')
      post({ id: requestId, type: 'progress', progress: 10, label: '正在初始化 OpenCV' })
      if (candidate instanceof Promise) {
        cvRuntime = await candidate
        return
      }
      const module = candidate as CV
      const moduleThen = (module as unknown as {
        then?: (callback: () => void) => unknown
      }).then
      if (typeof moduleThen === 'function') {
        post({ id: requestId, type: 'progress', progress: 14, label: '正在编译图像算法' })
        await new Promise<void>((resolve) => {
          moduleThen.call(module, () => {
            post({ id: requestId, type: 'progress', progress: 22, label: 'OpenCV 已就绪' })
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
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
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
  if (allowOuterMargin && corners.some((point) => (
    point.x < -0.06 || point.x > 1.06 || point.y < -0.06 || point.y > 1.06
  ))) return
  const ordered = orderPoints(corners)
  const unique = new Set(ordered.map((point) => `${point.x.toFixed(4)}:${point.y.toFixed(4)}`))
  if (unique.size === 4) candidates.push({ corners: ordered, source })
}

function collectContourCandidates(
  cv: CV,
  edgeMap: Mat,
  sourceName: DetectionCandidateSource,
) {
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
  const pixels = corners.map((point) => ({ x: point.x * width, y: point.y * height }))
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
  return candidates.map((candidate) => scoreDetectionCandidate({
    ...candidate,
    width: edgeMap.cols,
    height: edgeMap.rows,
    edgeSupport: edgeSupport(edgeMap, candidate.corners),
    contrast: boundaryContrast(imageData, candidate.corners),
    targetRatio,
  })).filter((candidate) => candidate.score > 0)
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
  return Math.abs(
    (right.midpoint.x - left.midpoint.x) * normal.x +
    (right.midpoint.y - left.midpoint.y) * normal.y,
  )
}

function collectHoughCandidates(lines: DetectedLine[], width: number, height: number) {
  const candidates: RawDetectionCandidate[] = []
  const tolerance = Math.PI / 8
  const minimumSeparation = Math.min(width, height) * 0.14
  for (const seed of lines.slice(0, 8)) {
    const perpendicular = (seed.angle + Math.PI / 2) % Math.PI
    const firstFamily = lines
      .filter((line) => lineAngleDifference(line.angle, seed.angle) <= tolerance)
      .slice(0, 7)
    const secondFamily = lines
      .filter((line) => lineAngleDifference(line.angle, perpendicular) <= tolerance)
      .slice(0, 7)
    for (let first = 0; first < firstFamily.length; first += 1) {
      for (let opposite = first + 1; opposite < firstFamily.length; opposite += 1) {
        if (linePairSeparation(firstFamily[first], firstFamily[opposite], seed.angle) < minimumSeparation) continue
        for (let second = 0; second < secondFamily.length; second += 1) {
          for (let adjacent = second + 1; adjacent < secondFamily.length; adjacent += 1) {
            if (linePairSeparation(secondFamily[second], secondFamily[adjacent], perpendicular) < minimumSeparation) continue
            const points = [
              lineIntersection(firstFamily[first], secondFamily[second]),
              lineIntersection(firstFamily[first], secondFamily[adjacent]),
              lineIntersection(firstFamily[opposite], secondFamily[second]),
              lineIntersection(firstFamily[opposite], secondFamily[adjacent]),
            ]
            if (points.some((point) => !point)) continue
            addRawCandidate(
              candidates,
              (points as Point[]).map((point) => ({ x: point.x / width, y: point.y / height })),
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

function refineCandidateWithLines(
  candidate: DetectionCandidate,
  lines: DetectedLine[],
  width: number,
  height: number,
) {
  const pixels = candidate.corners.map((point) => ({ x: point.x * width, y: point.y * height }))
  const band = Math.max(width, height) * 0.04
  const selected = pixels.map((start, index) => {
    const end = pixels[(index + 1) % 4]
    const original = lineFromPoints(start, end)
    return lines
      .filter((line) => (
        lineAngleDifference(line.angle, original.angle) < Math.PI / 15 &&
        distanceFromLine(line.midpoint, original) < band
      ))
      .sort((left, right) => (
        right.length / (1 + distanceFromLine(right.midpoint, original)) -
        left.length / (1 + distanceFromLine(left.midpoint, original))
      ))[0] ?? original
  })
  const refined = [
    lineIntersection(selected[3], selected[0]),
    lineIntersection(selected[0], selected[1]),
    lineIntersection(selected[1], selected[2]),
    lineIntersection(selected[2], selected[3]),
  ]
  if (refined.some((point) => !point)) return undefined
  const normalized = (refined as Point[]).map((point) => ({ x: point.x / width, y: point.y / height }))
  if (normalized.some((point) => point.x < -0.04 || point.x > 1.04 || point.y < -0.04 || point.y > 1.04)) return undefined
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
      { mat: createCannyMap(cv, normalized, kernel), source: 'normalized-canny' },
      { mat: createAdaptiveEdgeMap(cv, enhanced, kernel, false), source: 'adaptive-light' },
      { mat: createAdaptiveEdgeMap(cv, enhanced, kernel, true), source: 'adaptive-dark' },
    )
    combined = cv.Mat.zeros(source.rows, source.cols, cv.CV_8UC1)
    for (const edgeMap of edgeMaps) cv.bitwise_or(combined, edgeMap.mat, combined)

    if (requestId) post({ id: requestId, type: 'progress', progress: 68, label: '正在评分轮廓候选' })
    const rawCandidates = edgeMaps.flatMap((edgeMap) => (
      collectContourCandidates(cv, edgeMap.mat, edgeMap.source)
    ))
    const targetRatio = expectedRatio(mode, passportLayout)
    let evaluatedCandidates = evaluateCandidates(rawCandidates, combined, imageData, targetRatio)
    let candidates = suppressNestedCandidates(deduplicateCandidates(
      evaluatedCandidates,
      source.cols,
      source.rows,
    ))
    if (requestId) post({ id: requestId, type: 'progress', progress: 82, label: '正在补全缺失边线' })
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
      candidates = suppressNestedCandidates(deduplicateCandidates(
        evaluatedCandidates,
        source.cols,
        source.rows,
      ))
    }

    const best = candidates[0]
    if (best) {
      if (requestId) post({ id: requestId, type: 'progress', progress: 91, label: '正在精修文档四角' })
      const refinedCorners = refineCandidateWithLines(best, houghLines, source.cols, source.rows)
      if (refinedCorners) {
        const refined = evaluateCandidates(
          [{ corners: refinedCorners, source: best.source }],
          combined,
          imageData,
          targetRatio,
        )[0]
        if (
          refined &&
          refined.score >= best.score - 0.015 &&
          refined.edgeSupport >= best.edgeSupport - 0.04
        ) {
          evaluatedCandidates = [refined, ...evaluatedCandidates]
          candidates = suppressNestedCandidates(deduplicateCandidates(
            evaluatedCandidates,
            source.cols,
            source.rows,
          ))
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

function detectGlare(imageData: ImageData): GlareLevel {
  const { data, width, height } = imageData
  const step = Math.max(2, Math.round(Math.max(width, height) / 700))
  let samples = 0
  let glare = 0

  const lumaAt = (x: number, y: number) => {
    const offset = (y * width + x) * 4
    return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114
  }

  for (let y = step * 3; y < height - step * 3; y += step) {
    for (let x = step * 3; x < width - step * 3; x += step) {
      const offset = (y * width + x) * 4
      const red = data[offset]
      const green = data[offset + 1]
      const blue = data[offset + 2]
      const light = red * 0.299 + green * 0.587 + blue * 0.114
      const saturation = Math.max(red, green, blue) - Math.min(red, green, blue)
      const neighbor = Math.min(
        lumaAt(x - step * 3, y),
        lumaAt(x + step * 3, y),
        lumaAt(x, y - step * 3),
        lumaAt(x, y + step * 3),
      )
      samples += 1
      if (light > 246 && saturation < 24 && light - neighbor > 24) glare += 1
    }
  }

  const ratio = glare / Math.max(1, samples)
  if (ratio > 0.012) return 'severe'
  if (ratio > 0.002) return 'mild'
  return 'none'
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
    const detection = findDocumentQuad(cv, source, imageData, mode, passportLayout, id)
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
      glareLevel: detectGlare(imageData),
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
    rotation === 90
      ? cv.ROTATE_90_CLOCKWISE
      : rotation === 180
        ? cv.ROTATE_180
        : cv.ROTATE_90_COUNTERCLOCKWISE
  cv.rotate(source, output, rotateCode)
  return output
}

function applyToneAdjustments(
  mat: Mat,
  grayData: Uint8Array | undefined,
  backgroundData: Uint8Array | undefined,
  preset: FilterPreset,
  adjustments: EnhancementSettings,
) {
  const data = mat.data
  const contrast = 1 + adjustments.contrast / 100
  const brightness = adjustments.brightness

  for (let pixel = 0, index = 0; index < data.length; pixel += 1, index += 4) {
    const red = data[index]
    const green = data[index + 1]
    const blue = data[index + 2]
    const light = grayData?.[pixel] ?? red * 0.299 + green * 0.587 + blue * 0.114
    const background = backgroundData?.[pixel] ?? light
    const saturation = Math.max(red, green, blue) - Math.min(red, green, blue)
    let gain = 1

    if (
      (preset === 'smart' || preset === 'deshadow' || preset === 'ai-deshadow' || preset === 'deglare') &&
      light > 224 &&
      light - background > 10 &&
      saturation < 42
    ) {
      const target = background + 8 + (light - background) * (preset === 'deglare' ? 0.16 : 0.32)
      gain *= target / Math.max(1, light)
    }

    const saturationBoost = preset === 'vivid' ? 1.34 : preset === 'smart' ? 1.05 : 1
    const gray = light
    data[index] = clamp(((gray + (red - gray) * saturationBoost) * gain - 128) * contrast + 128 + brightness, 0, 255)
    data[index + 1] = clamp(((gray + (green - gray) * saturationBoost) * gain - 128) * contrast + 128 + brightness, 0, 255)
    data[index + 2] = clamp(((gray + (blue - gray) * saturationBoost) * gain - 128) * contrast + 128 + brightness, 0, 255)
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
      combined.data[index] = Math.max(
        closes[0].data[index] * 0.94,
        closes[1].data[index] * 0.98,
        closes[2].data[index],
      )
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

function applyClassicalShadowRemoval(
  cv: CV,
  source: Mat,
  preset: FilterPreset,
  shadowStrength: number,
) {
  const illumination = estimatePaperIllumination(cv, source)
  const gray = new cv.Mat()
  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    const dark = percentile(illumination.data, 0.2)
    const paper = percentile(illumination.data, 0.9)
    const variation = paper - dark
    // A flat page should remain flat. This prevents needless colour and exposure shifts.
    if (variation < 7) return
    const normalizedStrength = clamp(shadowStrength, 0, 100) / 100
    const blend = preset === 'black-white'
      ? 0.96
      : preset === 'deshadow'
        ? 0.55 + normalizedStrength * 0.4
        : 0.28 + normalizedStrength * 0.32
    const target = Math.max(paper, variation > 22 && paper < 184 ? 184 : paper)
    const pixels = source.data
    for (let pixel = 0, index = 0; pixel < illumination.data.length; pixel += 1, index += 4) {
      const background = Math.max(36, illumination.data[pixel])
      const ratio = clamp(target / background, 1, 2.2)
      const deficit = clamp((target - background - 2) / Math.max(16, variation * 0.72), 0, 1)
      const gain = 1 + (Math.pow(ratio, blend) - 1) * deficit
      pixels[index] = clamp(pixels[index] * gain, 0, 255)
      pixels[index + 1] = clamp(pixels[index + 1] * gain, 0, 255)
      pixels[index + 2] = clamp(pixels[index + 2] * gain, 0, 255)
    }
  } finally {
    illumination.delete()
    gray.delete()
  }
}

function processFilter(
  cv: CV,
  source: Mat,
  preset: FilterPreset,
  adjustments: EnhancementSettings,
) {
  const output = source.clone()
  const gray = new cv.Mat()
  const background = new cv.Mat()
  try {
    if (preset === 'smart' || preset === 'deshadow' || preset === 'black-white') {
      applyClassicalShadowRemoval(cv, output, preset, adjustments.shadowStrength ?? 50)
    }
    if (preset === 'black-white') {
      cv.cvtColor(output, gray, cv.COLOR_RGBA2GRAY)
      const claheOutput = new cv.Mat()
      const clahe = new cv.CLAHE(1.45, new cv.Size(10, 10))
      try {
        clahe.apply(gray, claheOutput)
        const blockSize = scaledOdd(Math.min(output.cols, output.rows) / 18, 31, 81)
        cv.adaptiveThreshold(
          claheOutput,
          background,
          255,
          cv.ADAPTIVE_THRESH_GAUSSIAN_C,
          cv.THRESH_BINARY,
          blockSize,
          11,
        )
      } finally {
        clahe.delete()
        claheOutput.delete()
      }
      cv.cvtColor(background, output, cv.COLOR_GRAY2RGBA)
    } else if (preset === 'grayscale') {
      cv.cvtColor(output, gray, cv.COLOR_RGBA2GRAY)
      const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8))
      try {
        clahe.apply(gray, background)
        cv.cvtColor(background, output, cv.COLOR_GRAY2RGBA)
      } finally {
        clahe.delete()
      }
    } else {
      cv.cvtColor(output, gray, cv.COLOR_RGBA2GRAY)
      if (preset === 'smart' || preset === 'deshadow' || preset === 'ai-deshadow' || preset === 'deglare') {
        const base = Math.min(81, Math.max(21, Math.floor(Math.min(output.cols, output.rows) / 18)))
        const kernelSize = base % 2 === 0 ? base + 1 : base
        cv.GaussianBlur(gray, background, new cv.Size(kernelSize, kernelSize), 0)
      }
      applyToneAdjustments(
        output,
        gray.data,
        background.empty() ? undefined : background.data,
        preset,
        adjustments,
      )
    }

    const presetSharpness = preset === 'sharpen'
      ? 0.9
      : preset === 'smart'
        ? 0.3
        : preset === 'deshadow' || preset === 'ai-deshadow'
          ? 0.2
          : 0
    const amount = presetSharpness + adjustments.sharpness / 180
    if (amount > 0.03) {
      const blur = new cv.Mat()
      try {
        cv.GaussianBlur(output, blur, new cv.Size(0, 0), 1.25)
        cv.addWeighted(output, 1 + amount, blur, -amount, 0, output)
      } finally {
        blur.delete()
      }
    }
    return output
  } catch (error) {
    output.delete()
    throw error
  } finally {
    gray.delete()
    background.delete()
  }
}

const floatView = new Float32Array(1)
const intView = new Uint32Array(floatView.buffer)

function floatToHalf(value: number) {
  floatView[0] = value
  const bits = intView[0]
  const sign = (bits >>> 16) & 0x8000
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15
  const mantissa = bits & 0x7fffff
  if (exponent <= 0) {
    if (exponent < -10) return sign
    return sign | ((mantissa | 0x800000) >> (14 - exponent))
  }
  if (exponent >= 31) return sign | 0x7c00
  return sign | (exponent << 10) | (mantissa >> 13)
}

function halfToFloat(value: number) {
  const sign = value & 0x8000 ? -1 : 1
  const exponent = (value >> 10) & 0x1f
  const fraction = value & 0x03ff
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

async function runAdvancedTensor(input: Uint16Array, width: number, height: number) {
  if (!advancedSession || !advancedOrt) throw new Error('高级去阴影模型尚未启动')
  const tensor = new advancedOrt.Tensor('float16', input, [1, 3, height, width])
  try {
    const result = await advancedSession.run({ [advancedSession.inputNames[0]]: tensor })
    const output = result[advancedSession.outputNames[0]]
    const values = new Float32Array(width * height * 3)
    const data = output.data
    const typed = data as unknown as {
      buffer: ArrayBufferLike
      byteOffset: number
      byteLength: number
      BYTES_PER_ELEMENT?: number
    }
    if (ArrayBuffer.isView(data) && typed.BYTES_PER_ELEMENT === 2) {
      // New Chromium builds expose float16 tensors as Float16Array while older
      // ONNX Runtime builds used Uint16Array. Reading the bits supports both.
      const halves = new Uint16Array(typed.buffer, typed.byteOffset, typed.byteLength / 2)
      for (let index = 0; index < values.length; index += 1) values[index] = halfToFloat(halves[index])
    } else if (data instanceof Float32Array) {
      values.set(data)
    } else {
      throw new Error('高级模型返回了不支持的数据格式')
    }
    output.dispose()
    return values
  } finally {
    tensor.dispose()
  }
}

function boxBlur(values: Float32Array, width: number, height: number, radius: number) {
  if (radius <= 0) return values.slice()
  const horizontal = new Float32Array(values.length)
  const output = new Float32Array(values.length)
  for (let y = 0; y < height; y += 1) {
    let sum = 0
    for (let x = -radius; x <= radius; x += 1) sum += values[y * width + clamp(x, 0, width - 1)]
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / (radius * 2 + 1)
      sum += values[y * width + clamp(x + radius + 1, 0, width - 1)]
      sum -= values[y * width + clamp(x - radius, 0, width - 1)]
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let y = -radius; y <= radius; y += 1) sum += horizontal[clamp(y, 0, height - 1) * width + x]
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / (radius * 2 + 1)
      sum += horizontal[clamp(y + radius + 1, 0, height - 1) * width + x]
      sum -= horizontal[clamp(y - radius, 0, height - 1) * width + x]
    }
  }
  return output
}

function correctionFingerprint(page: ScanPage) {
  const corners = page.corners
    .map((point) => `${point.x.toFixed(5)},${point.y.toFixed(5)}`)
    .join(';')
  return `v1:${page.id}:${page.sourceName}:${page.source.size}:${page.rotation}:${corners}`
}

async function createAdvancedCorrection(page: ScanPage, source: Mat): Promise<AdvancedCorrection> {
  if (!advancedSession || !advancedBackend) throw new Error('请先在设置中安装并启动高级去阴影模型')
  const scale = advancedInputSize / Math.max(source.cols, source.rows)
  const width = Math.max(64, Math.ceil((source.cols * scale) / 16) * 16)
  const height = Math.max(64, Math.ceil((source.rows * scale) / 16) * 16)
  const sourceCanvas = new OffscreenCanvas(source.cols, source.rows)
  const sourceContext = sourceCanvas.getContext('2d')
  const modelCanvas = new OffscreenCanvas(width, height)
  const modelContext = modelCanvas.getContext('2d', { willReadFrequently: true })
  if (!sourceContext || !modelContext) throw new Error('无法准备高级去阴影输入')
  sourceContext.putImageData(
    new ImageData(new Uint8ClampedArray(source.data), source.cols, source.rows),
    0,
    0,
  )
  modelContext.drawImage(sourceCanvas, 0, 0, width, height)
  const pixels = modelContext.getImageData(0, 0, width, height).data
  const plane = width * height
  const input = new Uint16Array(plane * 3)
  for (let pixel = 0, offset = 0; pixel < plane; pixel += 1, offset += 4) {
    input[pixel] = floatToHalf(pixels[offset] / 255)
    input[plane + pixel] = floatToHalf(pixels[offset + 1] / 255)
    input[plane * 2 + pixel] = floatToHalf(pixels[offset + 2] / 255)
  }
  const started = performance.now()
  const prediction = await runAdvancedTensor(input, width, height)
  const inferenceMs = performance.now() - started
  const logs = [new Float32Array(plane), new Float32Array(plane), new Float32Array(plane)]
  for (let pixel = 0, offset = 0; pixel < plane; pixel += 1, offset += 4) {
    const originalLuma = (
      pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
    ) / 255
    const predictedLuma = clamp(
      prediction[pixel] * 0.299 + prediction[plane + pixel] * 0.587 + prediction[plane * 2 + pixel] * 0.114,
      0,
      1,
    )
    const lumaLog = Math.log2(clamp(predictedLuma / Math.max(0.07, originalLuma), 0.5, 2.25))
    for (let channel = 0; channel < 3; channel += 1) {
      const original = pixels[offset + channel] / 255
      const predicted = clamp(prediction[channel * plane + pixel], 0, 1)
      const channelLog = Math.log2(clamp(predicted / Math.max(0.07, original), 0.5, 2.25))
      logs[channel][pixel] = lumaLog * 0.72 + channelLog * 0.28
    }
  }
  const radius = Math.max(2, Math.round(Math.min(width, height) / 48))
  const smoothed = logs.map((values) => boxBlur(values, width, height, radius))
  const mapCanvas = new OffscreenCanvas(width, height)
  const mapContext = mapCanvas.getContext('2d')
  if (!mapContext) throw new Error('无法生成高级去阴影校正图')
  const mapPixels = new Uint8ClampedArray(plane * 4)
  for (let pixel = 0, offset = 0; pixel < plane; pixel += 1, offset += 4) {
    mapPixels[offset] = clamp(128 + smoothed[0][pixel] * 96, 0, 255)
    mapPixels[offset + 1] = clamp(128 + smoothed[1][pixel] * 96, 0, 255)
    mapPixels[offset + 2] = clamp(128 + smoothed[2][pixel] * 96, 0, 255)
    mapPixels[offset + 3] = 255
  }
  mapContext.putImageData(new ImageData(mapPixels, width, height), 0, 0)
  const map = await mapCanvas.convertToBlob({ type: 'image/png' })
  return {
    fingerprint: correctionFingerprint(page),
    modelId: ADVANCED_MODEL_ID,
    modelVersion: ADVANCED_MODEL_VERSION,
    map,
    width,
    height,
    backend: advancedBackend,
    inferenceMs,
    createdAt: Date.now(),
  }
}

async function applyAdvancedCorrection(source: Mat, correction: AdvancedCorrection, shadowStrength: number) {
  const bitmap = await createImageBitmap(correction.map)
  const canvas = new OffscreenCanvas(source.cols, source.rows)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    bitmap.close()
    throw new Error('无法读取高级去阴影校正图')
  }
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, source.cols, source.rows)
  bitmap.close()
  const gains = context.getImageData(0, 0, source.cols, source.rows).data
  const blend = 0.45 + clamp(shadowStrength, 0, 100) / 100 * 0.55
  for (let offset = 0; offset < source.data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const gain = 2 ** ((gains[offset + channel] - 128) / 96)
      source.data[offset + channel] = clamp(
        source.data[offset + channel] * (1 + (gain - 1) * blend),
        0,
        255,
      )
    }
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

  const sourceTriangle = cv.matFromArray(4, 1, cv.CV_32FC2, sourcePoints.flatMap((point) => [point.x, point.y]))
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
  let correction: AdvancedCorrection | undefined

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
    if (page.filter === 'ai-deshadow') {
      correction = page.advancedCorrection?.fingerprint === correctionFingerprint(page)
        ? page.advancedCorrection
        : await createAdvancedCorrection(page, rotated)
      await applyAdvancedCorrection(
        rotated,
        correction,
        page.adjustments.shadowStrength ?? 50,
      )
    }
    filtered = processFilter(cv, rotated, page.filter, page.adjustments)
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
      correction,
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

async function releaseAdvancedModel(id?: string) {
  await advancedSession?.release()
  advancedSession = undefined
  advancedOrt = undefined
  advancedBackend = undefined
  advancedBenchmarkMs = 0
  advancedInputSize = 256
  if (id) post({ id, type: 'model-released' })
}

async function prepareAdvancedModel(id: string, model: ArrayBuffer, preferWebGpu: boolean) {
  await releaseAdvancedModel()
  post({ id, type: 'progress', progress: 18, label: '正在载入高级去阴影模型' })

  const configureWasm = (ort: typeof import('onnxruntime-web')) => {
    ort.env.wasm.wasmPaths = new URL('/vendor/ort/', workerScope.location.origin).href
    ort.env.wasm.numThreads = workerScope.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 2)
      : 1
    ort.env.wasm.proxy = false
  }

  const gpu = (navigator as Navigator & {
    gpu?: {
      requestAdapter: (options?: { powerPreference?: 'high-performance' }) => Promise<{
        isFallbackAdapter?: boolean
        info?: { isFallbackAdapter?: boolean }
      } | null>
    }
  }).gpu
  const adapter = preferWebGpu && workerScope.isSecureContext && gpu
    ? await gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null)
    : null
  const adapterInfo = adapter as {
    isFallbackAdapter?: boolean
    info?: { isFallbackAdapter?: boolean }
  } | null
  const canUseWebGpu = Boolean(
    adapterInfo && !adapterInfo.isFallbackAdapter && !adapterInfo.info?.isFallbackAdapter,
  )
  let lastError: unknown
  if (canUseWebGpu) {
    try {
      const ort = await import('onnxruntime-web/webgpu')
      configureWasm(ort)
      advancedSession = await ort.InferenceSession.create(model, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      })
      advancedOrt = ort
      advancedBackend = 'webgpu'
    } catch (error) {
      lastError = error
      await advancedSession?.release()
      advancedSession = undefined
    }
  }
  if (!advancedSession) {
    try {
      const ort = await import('onnxruntime-web')
      configureWasm(ort)
      advancedSession = await ort.InferenceSession.create(model, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })
      advancedOrt = ort
      advancedBackend = 'wasm'
    } catch (error) {
      await releaseAdvancedModel()
      const detail = error instanceof Error ? error.message : String(lastError ?? error)
      throw new Error(`高级去阴影模型无法启动：${detail}`)
    }
  }

  post({ id, type: 'progress', progress: 72, label: '正在自检并测速' })
  const size = 256
  const input = new Uint16Array(size * size * 3)
  const white = floatToHalf(0.82)
  input.fill(white)
  const started = performance.now()
  const output = await runAdvancedTensor(input, size, size)
  advancedBenchmarkMs = performance.now() - started
  if (!Number.isFinite(output[Math.floor(output.length / 2)])) {
    await releaseAdvancedModel()
    throw new Error('高级模型自检未通过')
  }
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4
  advancedInputSize = advancedBackend === 'webgpu' || advancedBenchmarkMs <= 700
    ? 512
    : advancedBenchmarkMs <= 1_500
      ? 384
      : 256
  if (memory <= 2) advancedInputSize = 256
  else if (memory <= 4 && advancedInputSize === 512) advancedInputSize = 384
  post({ id, type: 'progress', progress: 100, label: '高级去阴影已就绪' })
  post({
    id,
    type: 'model-ready',
    backend: advancedBackend ?? 'wasm',
    benchmarkMs: advancedBenchmarkMs,
    inputSize: advancedInputSize,
  })
}

workerScope.addEventListener('message', (event: MessageEvent<ScannerWorkerRequest>) => {
  const request = event.data
  const task = request.type === 'detect'
    ? detectDocument(request.id, request.source, request.mode, request.passportLayout)
    : request.type === 'render'
      ? renderPage(
          request.id,
          request.page,
          request.options.maxEdge,
          request.options.mimeType,
          request.options.quality,
        )
      : request.type === 'prepare-model'
        ? prepareAdvancedModel(request.id, request.model, request.preferWebGpu)
        : releaseAdvancedModel(request.id)

  void task.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '本地图像处理失败'
    post({ id: request.id, type: 'error', message })
  })
})
