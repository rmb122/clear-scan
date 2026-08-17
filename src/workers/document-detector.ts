import type { CV, Mat } from '@techstark/opencv-js'
import {
  calibrateDetectionConfidence,
  deduplicateCandidates,
  lineAngleDifference,
  lineIntersection,
  scoreDetectionCandidate,
  suppressNestedCandidates,
  type DetectionCandidate,
  type DetectionCandidateSource,
  type LineEquation,
} from '@/lib/document-detection'
import { clamp, orderPoints } from '@/lib/geometry'
import type { NormalizedQuad, PassportLayout, Point, ScanMode } from '@/lib/types'
import { percentile, scaledOdd } from './worker-image-utils'

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
    const median = percentile(blurred.data, 0.5, 350_000)
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
              addRawCandidate(
                candidates,
                readQuad(approximation, edgeMap.cols, edgeMap.rows),
                sourceName,
              )
            }
            const hullPerimeter = cv.arcLength(hull, true)
            cv.approxPolyDP(hull, hullApproximation, hullPerimeter * epsilon, true)
            if (hullApproximation.rows === 4 && cv.isContourConvex(hullApproximation)) {
              addRawCandidate(
                candidates,
                readQuad(hullApproximation, edgeMap.cols, edgeMap.rows),
                sourceName,
              )
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
        if (
          linePairSeparation(firstFamily[first], firstFamily[opposite], seed.angle) <
          minimumSeparation
        )
          continue
        for (let second = 0; second < secondFamily.length; second += 1) {
          for (let adjacent = second + 1; adjacent < secondFamily.length; adjacent += 1) {
            if (
              linePairSeparation(secondFamily[second], secondFamily[adjacent], perpendicular) <
              minimumSeparation
            )
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
  return (
    Math.abs(line.a * point.x + line.b * point.y + line.c) /
    Math.max(0.001, Math.hypot(line.a, line.b))
  )
}

function refineCandidateWithLines(
  candidate: DetectionCandidate,
  lines: DetectedLine[],
  width: number,
  height: number,
) {
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
  if (
    normalized.some(
      (point) => point.x < -0.04 || point.x > 1.04 || point.y < -0.04 || point.y > 1.04,
    )
  )
    return undefined
  return orderPoints(normalized)
}

export function findDocumentQuad(
  cv: CV,
  source: Mat,
  imageData: ImageData,
  mode: ScanMode,
  passportLayout?: PassportLayout,
  onProgress?: (progress: number, label: string) => void,
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

    onProgress?.(68, '正在评分轮廓候选')
    const rawCandidates = edgeMaps.flatMap((edgeMap) =>
      collectContourCandidates(cv, edgeMap.mat, edgeMap.source),
    )
    const targetRatio = expectedRatio(mode, passportLayout)
    let evaluatedCandidates = evaluateCandidates(rawCandidates, combined, imageData, targetRatio)
    let candidates = suppressNestedCandidates(
      deduplicateCandidates(evaluatedCandidates, source.cols, source.rows),
    )
    onProgress?.(82, '正在补全缺失边线')
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
      candidates = suppressNestedCandidates(
        deduplicateCandidates(evaluatedCandidates, source.cols, source.rows),
      )
    }

    const best = candidates[0]
    if (best) {
      onProgress?.(91, '正在精修文档四角')
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
          candidates = suppressNestedCandidates(
            deduplicateCandidates(evaluatedCandidates, source.cols, source.rows),
          )
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
