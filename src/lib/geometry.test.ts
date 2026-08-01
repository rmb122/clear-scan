import { describe, expect, it } from 'vitest'
import { DEFAULT_QUAD, fitWithin, orderPoints, quadAspectRatio } from './geometry'

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
