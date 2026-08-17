import { describe, expect, it } from 'vitest'
import { histogramPercentile, percentile, scaledOdd } from './worker-image-utils'

describe('worker image utilities', () => {
  it('calculates byte percentiles from samples and existing histograms', () => {
    expect(percentile(new Uint8Array([0, 10, 20, 30]), 0.5)).toBe(10)

    const histogram = new Uint32Array(256)
    histogram[40] = 2
    histogram[180] = 2
    expect(histogramPercentile(histogram, 4, 0.75)).toBe(180)
  })

  it('keeps OpenCV kernel sizes odd and inside their bounds', () => {
    expect(scaledOdd(20, 3, 31)).toBe(21)
    expect(scaledOdd(40, 3, 31)).toBe(31)
    expect(scaledOdd(2, 3, 31)).toBe(3)
  })
})
