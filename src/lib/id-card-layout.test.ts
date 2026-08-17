import { describe, expect, it } from 'vitest'
import { getIdCardSheetLayout } from './id-card-layout'

describe('ID card sheet layout', () => {
  it('gives both sides most of the width on an A4 export', () => {
    const canvasWidth = 2480
    const canvasHeight = 3508
    const layout = getIdCardSheetLayout(canvasWidth, canvasHeight)

    expect(layout.front.width / canvasWidth).toBeCloseTo(0.8, 2)
    expect(layout.front).toMatchObject({
      x: layout.back.x,
      width: layout.back.width,
      height: layout.back.height,
    })
    expect(layout.front.y).toBeGreaterThan(0)
    expect(layout.back.y + layout.back.height).toBeLessThan(canvasHeight)

    const cardArea = layout.front.width * layout.front.height * 2
    expect(cardArea / (canvasWidth * canvasHeight)).toBeGreaterThan(0.5)
  })

  it('keeps the cards inside a shorter canvas', () => {
    const canvasWidth = 1200
    const canvasHeight = 1000
    const layout = getIdCardSheetLayout(canvasWidth, canvasHeight)

    expect(layout.front.x).toBeGreaterThanOrEqual(0)
    expect(layout.front.y).toBeGreaterThanOrEqual(0)
    expect(layout.back.y + layout.back.height).toBeLessThanOrEqual(canvasHeight)
  })
})
