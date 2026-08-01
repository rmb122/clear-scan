import { describe, expect, it } from 'vitest'
import {
  calibrateDetectionConfidence,
  deduplicateCandidates,
  lineIntersection,
  scoreDetectionCandidate,
  suppressNestedCandidates,
} from './document-detection'
import type { NormalizedQuad } from './types'

const centered: NormalizedQuad = [
  { x: 0.12, y: 0.2 },
  { x: 0.88, y: 0.2 },
  { x: 0.88, y: 0.8 },
  { x: 0.12, y: 0.8 },
]

describe('document detection scoring', () => {
  it('scores mode ratios in source pixels instead of normalized coordinates', () => {
    const candidate = scoreDetectionCandidate({
      corners: centered,
      source: 'canny',
      width: 1600,
      height: 1000,
      edgeSupport: 1,
      contrast: 1,
      targetRatio: 1.6 * (0.76 / 0.6),
    })
    expect(candidate.ratioScore).toBeGreaterThan(0.98)
  })

  it('penalizes an internal frame whose shape is implausible for a passport page', () => {
    const passport = scoreDetectionCandidate({
      corners: centered,
      source: 'adaptive-dark',
      width: 1080,
      height: 1920,
      edgeSupport: 1,
      contrast: 1,
      targetRatio: 1.42,
    })
    const tallInternalFrame = scoreDetectionCandidate({
      corners: [
        { x: 0.56, y: 0.2 },
        { x: 0.94, y: 0.2 },
        { x: 0.94, y: 0.96 },
        { x: 0.56, y: 0.96 },
      ],
      source: 'adaptive-dark',
      width: 1080,
      height: 1920,
      edgeSupport: 1,
      contrast: 1,
      targetRatio: 1.42,
    })

    expect(tallInternalFrame.ratioScore).toBeLessThan(0.58)
    expect(passport.score).toBeGreaterThan(tallInternalFrame.score)
  })

  it('penalizes a candidate that simply follows the image frame', () => {
    const frame = scoreDetectionCandidate({
      corners: [
        { x: 0.001, y: 0.001 },
        { x: 0.999, y: 0.001 },
        { x: 0.999, y: 0.999 },
        { x: 0.001, y: 0.999 },
      ],
      source: 'canny',
      width: 1200,
      height: 900,
      edgeSupport: 1,
      contrast: 1,
    })
    const document = scoreDetectionCandidate({
      corners: centered,
      source: 'canny',
      width: 1200,
      height: 900,
      edgeSupport: 1,
      contrast: 1,
    })
    expect(frame.penalty).toBe(0.35)
    expect(document.score).toBeGreaterThan(frame.score)
  })

  it('deduplicates overlapping candidates before confidence calibration', () => {
    const best = scoreDetectionCandidate({ corners: centered, source: 'canny', width: 1200, height: 900, edgeSupport: 1, contrast: 1 })
    const duplicate = { ...best, source: 'normalized-canny' as const, score: best.score - 0.01 }
    const unique = deduplicateCandidates([best, duplicate], 1200, 900)
    expect(unique).toHaveLength(1)
    expect(calibrateDetectionConfidence(unique[0])).toBeGreaterThan(0.62)
  })

  it('prefers a plausible enclosing passport edge over a stronger internal frame', () => {
    const inner = scoreDetectionCandidate({
      corners: [
        { x: 0.19, y: 0.2 },
        { x: 0.8, y: 0.23 },
        { x: 0.78, y: 0.81 },
        { x: 0.17, y: 0.76 },
      ],
      source: 'adaptive-dark',
      width: 1200,
      height: 900,
      edgeSupport: 1,
      contrast: 1,
      targetRatio: 1.42,
    })
    const outer = scoreDetectionCandidate({
      corners: [
        { x: 0.11, y: 0.11 },
        { x: 0.88, y: 0.16 },
        { x: 0.84, y: 0.88 },
        { x: 0.08, y: 0.82 },
      ],
      source: 'adaptive-dark',
      width: 1200,
      height: 900,
      edgeSupport: 1,
      contrast: 0.27,
      targetRatio: 1.42,
    })

    expect(inner.score).toBeGreaterThan(outer.score)
    expect(suppressNestedCandidates([inner, outer])[0].corners).toEqual(outer.corners)
  })

  it('does not replace a document with a much larger enclosing scene', () => {
    const document = scoreDetectionCandidate({
      corners: centered,
      source: 'canny',
      width: 1200,
      height: 900,
      edgeSupport: 1,
      contrast: 1,
      targetRatio: 1.42,
    })
    const scene = scoreDetectionCandidate({
      corners: [
        { x: 0.02, y: 0.02 },
        { x: 0.98, y: 0.02 },
        { x: 0.98, y: 0.98 },
        { x: 0.02, y: 0.98 },
      ],
      source: 'adaptive-dark',
      width: 1200,
      height: 900,
      edgeSupport: 1,
      contrast: 1,
      targetRatio: 1.42,
    })

    expect(scene.area / document.area).toBeGreaterThan(1.9)
    expect(suppressNestedCandidates([document, scene])[0].corners).toEqual(document.corners)
  })

  it('intersects two side equations', () => {
    expect(lineIntersection({ a: 1, b: 0, c: -10 }, { a: 0, b: 1, c: -20 })).toEqual({ x: 10, y: 20 })
  })
})
