import { clamp, distance, orderPoints } from './geometry'
import type { NormalizedQuad, Point } from './types'

export const DETECTION_CONFIDENCE_THRESHOLD = 0.62

export type DetectionCandidateSource =
  | 'canny'
  | 'normalized-canny'
  | 'adaptive-light'
  | 'adaptive-dark'
  | 'hough'
  | 'min-area-rect'

export interface DetectionCandidate {
  corners: NormalizedQuad
  source: DetectionCandidateSource
  score: number
  edgeSupport: number
  contrast: number
  area: number
  angleScore: number
  oppositeScore: number
  ratioScore: number
  centerScore: number
  penalty: number
}

interface CandidateInput {
  corners: NormalizedQuad
  source: DetectionCandidateSource
  width: number
  height: number
  edgeSupport: number
  contrast: number
  targetRatio?: number
}

export interface LineEquation {
  a: number
  b: number
  c: number
}

function pixelPoints(corners: NormalizedQuad, width: number, height: number) {
  return corners.map((point) => ({ x: point.x * width, y: point.y * height })) as NormalizedQuad
}

function polygonArea(points: Point[]) {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length]
    sum += points[index].x * next.y - next.x * points[index].y
  }
  return Math.abs(sum) / 2
}

function directionAngle(left: Point, right: Point) {
  let angle = Math.atan2(right.y - left.y, right.x - left.x) % Math.PI
  if (angle < 0) angle += Math.PI
  return angle
}

export function lineAngleDifference(left: number, right: number) {
  const difference = Math.abs(left - right) % Math.PI
  return Math.min(difference, Math.PI - difference)
}

function cornerAngles(points: NormalizedQuad) {
  return points.map((point, index) => {
    const previous = points[(index + 3) % 4]
    const next = points[(index + 1) % 4]
    const first = { x: previous.x - point.x, y: previous.y - point.y }
    const second = { x: next.x - point.x, y: next.y - point.y }
    const denominator = Math.max(0.001, Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y))
    return Math.acos(clamp((first.x * second.x + first.y * second.y) / denominator, -1, 1))
  })
}

export function scoreDetectionCandidate(input: CandidateInput): DetectionCandidate {
  const corners = orderPoints(input.corners)
  const pixels = pixelPoints(corners, input.width, input.height)
  const imageArea = input.width * input.height
  const area = polygonArea(pixels) / Math.max(1, imageArea)
  const diagonal = Math.hypot(input.width, input.height)
  const sides = pixels.map((point, index) => distance(point, pixels[(index + 1) % 4]))
  const angles = cornerAngles(pixels)
  const invalidGeometry =
    area < 0.06 ||
    area > 0.985 ||
    Math.min(...sides) < diagonal * 0.055 ||
    angles.some((angle) => angle < Math.PI / 9 || angle > (Math.PI * 8) / 9)

  const angleScore =
    angles.reduce((sum, angle) => sum + Math.exp(-Math.abs(angle - Math.PI / 2) / (Math.PI / 3)), 0) / 4
  const oppositeScore =
    (Math.exp(
      -lineAngleDifference(directionAngle(pixels[0], pixels[1]), directionAngle(pixels[3], pixels[2])) / (Math.PI / 6),
    ) +
      Math.exp(
        -lineAngleDifference(directionAngle(pixels[0], pixels[3]), directionAngle(pixels[1], pixels[2])) /
          (Math.PI / 6),
      )) /
    2
  const horizontal = Math.max(sides[0], sides[2])
  const vertical = Math.max(sides[1], sides[3])
  const rawRatio = horizontal / Math.max(1, vertical)
  const orientationFreeRatio = Math.max(rawRatio, 1 / Math.max(0.001, rawRatio))
  const ratioScore = input.targetRatio
    ? Math.exp(-Math.abs(Math.log(orientationFreeRatio / input.targetRatio)) * 1.8)
    : 1
  const center = corners.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 })
  const centerScore = 1 - clamp(Math.hypot(center.x - 0.5, center.y - 0.5) / 0.72)
  const areaScore = area < 0.36 ? clamp((area - 0.04) / 0.32) : area <= 0.9 ? 1 : 1 - clamp((area - 0.9) / 0.085) * 0.42
  const borderCorners = corners.filter(
    (point) => point.x < 0.015 || point.x > 0.985 || point.y < 0.015 || point.y > 0.985,
  ).length
  const borderPenalty =
    area > 0.94 && borderCorners >= 3
      ? 0.35
      : area > 0.76 && borderCorners >= 3
        ? 0.24
        : area > 0.86 && borderCorners >= 2
          ? 0.12
          : 0
  const fallbackPenalty = input.source === 'min-area-rect' ? 0.12 : 0
  const perspectivePenalty = input.targetRatio
    ? clamp((0.68 - oppositeScore) / 0.3) * 0.15 + clamp((0.72 - angleScore) / 0.2) * 0.08
    : 0
  const ratioPenalty = input.targetRatio ? clamp((0.58 - ratioScore) / 0.38) * 0.2 : 0
  const penalty = borderPenalty + fallbackPenalty + perspectivePenalty + ratioPenalty
  const edgeSupport = clamp(input.edgeSupport)
  const contrast = clamp(input.contrast)
  const score = invalidGeometry
    ? 0
    : input.targetRatio
      ? edgeSupport * 0.32 +
        areaScore * 0.18 +
        angleScore * 0.14 +
        oppositeScore * 0.08 +
        contrast * 0.14 +
        ratioScore * 0.1 +
        centerScore * 0.04 -
        penalty
      : edgeSupport * 0.37 +
        areaScore * 0.18 +
        angleScore * 0.16 +
        oppositeScore * 0.09 +
        contrast * 0.16 +
        centerScore * 0.04 -
        penalty

  return {
    corners,
    source: input.source,
    score: clamp(score),
    edgeSupport,
    contrast,
    area,
    angleScore,
    oppositeScore,
    ratioScore,
    centerScore,
    penalty,
  }
}

function meanCornerDistance(left: NormalizedQuad, right: NormalizedQuad, width: number, height: number) {
  return (
    left.reduce(
      (sum, point, index) => sum + Math.hypot((point.x - right[index].x) * width, (point.y - right[index].y) * height),
      0,
    ) /
    4 /
    Math.hypot(width, height)
  )
}

export function deduplicateCandidates(
  candidates: DetectionCandidate[],
  width: number,
  height: number,
  threshold = 0.025,
) {
  const unique: DetectionCandidate[] = []
  for (const candidate of [...candidates].sort((left, right) => right.score - left.score)) {
    if (!unique.some((item) => meanCornerDistance(item.corners, candidate.corners, width, height) < threshold)) {
      unique.push(candidate)
    }
  }
  return unique
}

function pointInsideQuad(point: Point, quad: NormalizedQuad, tolerance = 0.0025) {
  let hasPositive = false
  let hasNegative = false
  for (let index = 0; index < quad.length; index += 1) {
    const start = quad[index]
    const end = quad[(index + 1) % quad.length]
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)
    if (cross > tolerance) hasPositive = true
    if (cross < -tolerance) hasNegative = true
  }
  return !(hasPositive && hasNegative)
}

function quadCenter(quad: NormalizedQuad) {
  return quad.reduce((center, point) => ({ x: center.x + point.x / 4, y: center.y + point.y / 4 }), { x: 0, y: 0 })
}

export function suppressNestedCandidates(candidates: DetectionCandidate[]) {
  const adjusted = candidates.map((candidate) => {
    const candidateCenter = quadCenter(candidate.corners)
    const enclosing = candidates.find((outer) => {
      if (outer === candidate) return false
      const areaRatio = outer.area / Math.max(0.0001, candidate.area)
      if (areaRatio < 1.18 || areaRatio > 1.9) return false
      if (outer.score < candidate.score - 0.14) return false
      if (outer.edgeSupport < candidate.edgeSupport - 0.18) return false
      if (outer.ratioScore < 0.72 || outer.angleScore < 0.78 || outer.oppositeScore < 0.72) return false
      const outerCenter = quadCenter(outer.corners)
      if (Math.hypot(candidateCenter.x - outerCenter.x, candidateCenter.y - outerCenter.y) > 0.11) return false
      return candidate.corners.every((point) => pointInsideQuad(point, outer.corners))
    })
    if (!enclosing) return candidate

    const nestingPenalty = clamp(candidate.score - enclosing.score + 0.025, 0.04, 0.14)
    return {
      ...candidate,
      score: clamp(candidate.score - nestingPenalty),
      penalty: candidate.penalty + nestingPenalty,
    }
  })
  return adjusted.sort((left, right) => right.score - left.score)
}

export function calibrateDetectionConfidence(best?: DetectionCandidate, second?: DetectionCandidate) {
  if (!best) return 0
  const absolute = clamp((best.score - 0.44) / 0.42)
  const separation = second ? clamp((best.score - second.score) / 0.12) : 1
  return clamp(absolute * 0.76 + separation * 0.24)
}

export function lineIntersection(left: LineEquation, right: LineEquation): Point | undefined {
  const determinant = left.a * right.b - right.a * left.b
  if (Math.abs(determinant) < 0.000001) return undefined
  return {
    x: (left.b * right.c - right.b * left.c) / determinant,
    y: (left.c * right.a - right.c * left.a) / determinant,
  }
}
