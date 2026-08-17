import { clamp } from '@/lib/geometry'

export async function blobToImageData(blob: Blob, maxEdge: number) {
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

export function percentile(data: Uint8Array, fraction: number, sampleLimit = 500_000) {
  const histogram = new Uint32Array(256)
  const step = Math.max(1, Math.floor(data.length / sampleLimit))
  let count = 0
  for (let index = 0; index < data.length; index += step) {
    histogram[data[index]] += 1
    count += 1
  }
  return histogramPercentile(histogram, count, fraction)
}

export function histogramPercentile(histogram: Uint32Array, count: number, fraction: number) {
  const target = count * fraction
  let total = 0
  for (let value = 0; value < histogram.length; value += 1) {
    total += histogram[value]
    if (total >= target) return value
  }
  return histogram.length - 1
}

export function scaledOdd(value: number, minimum: number, maximum: number) {
  let result = Math.round(clamp(value, minimum, maximum))
  if (result % 2 === 0) result += result < maximum ? 1 : -1
  return result
}
