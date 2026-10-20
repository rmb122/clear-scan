import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUAD,
  fitWithin,
  isValidCropQuad,
  orderPoints,
  quadAspectRatio,
} from '@/lib/geometry'
import type { NormalizedQuad } from '@/lib/types'

describe('document geometry', () => {
  it('orders arbitrary corner points clockwise from top-left', () => {
    const ordered = orderPoints([
      { x: 0.9, y: 0.85 },
      { x: 0.12, y: 0.14 },
      { x: 0.1, y: 0.88 },
      { x: 0.92, y: 0.12 },
    ])
    expect(ordered).toEqual([
      { x: 0.12, y: 0.14 },
      { x: 0.92, y: 0.12 },
      { x: 0.9, y: 0.85 },
      { x: 0.1, y: 0.88 },
    ])
  })

  it('falls back to a safe inset for invalid quads', () => {
    expect(orderPoints([{ x: 0, y: 0 }])).toEqual(DEFAULT_QUAD)
  })

  it('accepts a tilted perspective crop without requiring axis-aligned corners', () => {
    expect(
      isValidCropQuad([
        { x: 0.45, y: 0.05 },
        { x: 0.95, y: 0.6 },
        { x: 0.55, y: 0.95 },
        { x: 0.05, y: 0.4 },
      ]),
    ).toBe(true)
  })

  it.each<{ scenario: string; corners: NormalizedQuad }>([
    {
      scenario: 'swapped right corners',
      corners: [DEFAULT_QUAD[0], DEFAULT_QUAD[2], DEFAULT_QUAD[1], DEFAULT_QUAD[3]],
    },
    {
      scenario: 'an inward fold',
      corners: [{ x: 0.6, y: 0.6 }, DEFAULT_QUAD[1], DEFAULT_QUAD[2], DEFAULT_QUAD[3]],
    },
    {
      scenario: 'overlapping corners',
      corners: [DEFAULT_QUAD[0], DEFAULT_QUAD[2], DEFAULT_QUAD[2], DEFAULT_QUAD[3]],
    },
    {
      scenario: 'three collinear corners',
      corners: [DEFAULT_QUAD[0], { x: 0.5, y: 0.5 }, DEFAULT_QUAD[2], DEFAULT_QUAD[3]],
    },
    {
      scenario: 'reversed corner order',
      corners: [DEFAULT_QUAD[0], DEFAULT_QUAD[3], DEFAULT_QUAD[2], DEFAULT_QUAD[1]],
    },
  ])('rejects $scenario without reordering the crop', ({ corners }) => {
    expect(isValidCropQuad(corners)).toBe(false)
  })

  it('calculates crop aspect ratio using source dimensions', () => {
    expect(quadAspectRatio(DEFAULT_QUAD, 1600, 1000)).toBeCloseTo(1.6, 1)
  })

  it('fits content without changing its aspect ratio', () => {
    expect(fitWithin(2000, 1000, 500, 500)).toEqual({
      width: 500,
      height: 250,
      x: 0,
      y: 125,
    })
  })
})
