import type { NormalizedQuad, Point } from './types'

export const DEFAULT_QUAD: NormalizedQuad = [
  { x: 0.04, y: 0.04 },
  { x: 0.96, y: 0.04 },
  { x: 0.96, y: 0.96 },
  { x: 0.04, y: 0.96 },
]

export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

export function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function isValidCropQuad(quad: NormalizedQuad) {
  if (quad.length !== 4) return false

  return quad.every((point, index) => {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.x > 1 ||
      point.y < 0 ||
      point.y > 1
    ) {
      return false
    }
    const next = quad[(index + 1) % 4]
    const afterNext = quad[(index + 2) % 4]
    const cross =
      (next.x - point.x) * (afterNext.y - next.y) - (next.y - point.y) * (afterNext.x - next.x)
    // Positive turns keep screen-space corners clockwise and strictly convex.
    return cross > 1e-6
  })
}

export function constrainCropCorner(quad: NormalizedQuad, index: number, target: Point): Point {
  const next = [...quad] as NormalizedQuad
  next[index] = target
  if (isValidCropQuad(next)) return target

  const start = quad[index]
  let constrained = start
  let validFraction = 0
  let invalidFraction = 1
  // A convex crop's valid drag path is a single interval. Refine its boundary to subpixel precision.
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const fraction = (validFraction + invalidFraction) / 2
    const point = {
      x: start.x + (target.x - start.x) * fraction,
      y: start.y + (target.y - start.y) * fraction,
    }
    next[index] = point
    if (isValidCropQuad(next)) {
      validFraction = fraction
      constrained = point
    } else {
      invalidFraction = fraction
    }
  }
  return constrained
}

export function orderPoints(points: Point[]): NormalizedQuad {
  if (points.length !== 4) {
    return DEFAULT_QUAD.map((point) => ({ ...point })) as NormalizedQuad
  }

  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }),
    { x: 0, y: 0 },
  )
  const clockwise = [...points].sort(
    (left, right) =>
      Math.atan2(left.y - center.y, left.x - center.x) -
      Math.atan2(right.y - center.y, right.x - center.x),
  )
  const topLeftIndex = clockwise.reduce(
    (bestIndex, point, index) =>
      point.x + point.y < clockwise[bestIndex].x + clockwise[bestIndex].y ? index : bestIndex,
    0,
  )
  const ordered = [...clockwise.slice(topLeftIndex), ...clockwise.slice(0, topLeftIndex)]

  return ordered.map((point) => ({
    x: clamp(point.x),
    y: clamp(point.y),
  })) as NormalizedQuad
}

export function quadAspectRatio(quad: NormalizedQuad, width: number, height: number) {
  const pixels = quad.map((point) => ({ x: point.x * width, y: point.y * height }))
  const top = distance(pixels[0], pixels[1])
  const bottom = distance(pixels[3], pixels[2])
  const left = distance(pixels[0], pixels[3])
  const right = distance(pixels[1], pixels[2])
  return Math.max(top, bottom) / Math.max(1, Math.max(left, right))
}

export function fitWithin(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
) {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    width,
    height,
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
  }
}
