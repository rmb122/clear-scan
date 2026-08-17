import type { CV, Mat } from '@techstark/opencv-js'
import { clamp } from '@/lib/geometry'
import { DEFAULT_WHITENING_STRENGTH } from '@/lib/types'
import type { EnhancementEffects, EnhancementSettings, GlareLevel } from '@/lib/types'
import { histogramPercentile, percentile, scaledOdd } from './worker-image-utils'
export function detectGlare(cv: CV, source: Mat): GlareLevel {
  const highlight = recoverableHighlightMask(cv, source)
  try {
    const ratio = highlight.count / Math.max(1, highlight.data.length)
    if (ratio > 0.012) return 'severe'
    if (ratio > 0.002) return 'mild'
    return 'none'
  } finally {
    highlight.source.delete()
  }
}

function applyToneAdjustments(mat: Mat, adjustments: EnhancementSettings) {
  if (adjustments.brightness === 0 && adjustments.contrast === 0) return
  const data = mat.data
  const contrast = 1 + adjustments.contrast / 100
  const brightness = adjustments.brightness

  for (let index = 0; index < data.length; index += 4) {
    data[index] = clamp((data[index] - 128) * contrast + 128 + brightness, 0, 255)
    data[index + 1] = clamp((data[index + 1] - 128) * contrast + 128 + brightness, 0, 255)
    data[index + 2] = clamp((data[index + 2] - 128) * contrast + 128 + brightness, 0, 255)
  }
}

function mix(left: number, right: number, amount: number) {
  return left + (right - left) * clamp(amount, 0, 1)
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1
  const normalized = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return normalized * normalized * (3 - 2 * normalized)
}

function pixelLuma(red: number, green: number, blue: number) {
  return red * 0.299 + green * 0.587 + blue * 0.114
}

interface HighlightRegion {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface HighlightAnalysis {
  data: Uint8Array
  width: number
  height: number
  count: number
  regions: HighlightRegion[]
  source: Mat
}

function recoverableHighlightMask(cv: CV, source: Mat): HighlightAnalysis {
  const analysis = new cv.Mat()
  try {
    const scale = Math.min(1, 640 / Math.max(source.cols, source.rows))
    const width = Math.max(1, Math.round(source.cols * scale))
    const height = Math.max(1, Math.round(source.rows * scale))
    cv.resize(source, analysis, new cv.Size(width, height), 0, 0, cv.INTER_AREA)
    const candidate = new Uint8Array(width * height)
    for (let pixel = 0, index = 0; pixel < candidate.length; pixel += 1, index += 4) {
      const red = analysis.data[index]
      const green = analysis.data[index + 1]
      const blue = analysis.data[index + 2]
      const light = pixelLuma(red, green, blue)
      const saturation = Math.max(red, green, blue) - Math.min(red, green, blue)
      candidate[pixel] = light >= 194 && saturation <= 86 ? 1 : 0
    }
    // A bright page is normally connected to the crop boundary. Excluding that
    // component prevents paper margins from being pulled toward nearby ink.
    const exterior = new Uint8Array(candidate.length)
    const queue = new Int32Array(candidate.length)
    let head = 0
    let tail = 0
    const enqueue = (pixel: number) => {
      if (!candidate[pixel] || exterior[pixel]) return
      exterior[pixel] = 1
      queue[tail] = pixel
      tail += 1
    }
    for (let x = 0; x < width; x += 1) {
      enqueue(x)
      enqueue((height - 1) * width + x)
    }
    for (let y = 1; y < height - 1; y += 1) {
      enqueue(y * width)
      enqueue(y * width + width - 1)
    }
    while (head < tail) {
      const pixel = queue[head]
      head += 1
      const x = pixel % width
      if (x > 0) enqueue(pixel - 1)
      if (x + 1 < width) enqueue(pixel + 1)
      if (pixel >= width) enqueue(pixel - width)
      if (pixel + width < candidate.length) enqueue(pixel + width)
      if (x > 0 && pixel >= width) enqueue(pixel - width - 1)
      if (x + 1 < width && pixel >= width) enqueue(pixel - width + 1)
      if (x > 0 && pixel + width < candidate.length) enqueue(pixel + width - 1)
      if (x + 1 < width && pixel + width < candidate.length) enqueue(pixel + width + 1)
    }

    // Only broad, graduated highlight blobs are recoverable glare. Connected
    // component geometry and tone spread protect legitimate white text, logos,
    // barcodes and solid design elements inside coloured regions.
    const recoverable = new Uint8Array(candidate.length)
    const regions: HighlightRegion[] = []
    let recoverableCount = 0
    const minimumArea = Math.max(32, Math.round(candidate.length * 0.00025))
    const maximumArea = Math.round(candidate.length * 0.12)
    const minimumSpan = Math.max(6, Math.round(Math.min(width, height) * 0.018))
    for (let start = 0; start < candidate.length; start += 1) {
      if (!candidate[start] || exterior[start]) continue
      head = 0
      tail = 0
      candidate[start] = 0
      queue[tail] = start
      tail += 1
      let minX = width
      let maxX = 0
      let minY = height
      let maxY = 0
      let sum = 0
      let sumSquares = 0
      let minimumLight = 255
      let maximumLight = 0
      let shoulderPixels = 0

      const enqueueComponent = (pixel: number) => {
        if (!candidate[pixel] || exterior[pixel]) return
        candidate[pixel] = 0
        queue[tail] = pixel
        tail += 1
      }
      while (head < tail) {
        const pixel = queue[head]
        head += 1
        const x = pixel % width
        const y = Math.floor(pixel / width)
        const index = pixel * 4
        const light = pixelLuma(
          analysis.data[index],
          analysis.data[index + 1],
          analysis.data[index + 2],
        )
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
        sum += light
        sumSquares += light * light
        minimumLight = Math.min(minimumLight, light)
        maximumLight = Math.max(maximumLight, light)
        if (light >= 202 && light <= 240) shoulderPixels += 1

        if (x > 0) enqueueComponent(pixel - 1)
        if (x + 1 < width) enqueueComponent(pixel + 1)
        if (pixel >= width) enqueueComponent(pixel - width)
        if (pixel + width < candidate.length) enqueueComponent(pixel + width)
        if (x > 0 && pixel >= width) enqueueComponent(pixel - width - 1)
        if (x + 1 < width && pixel >= width) enqueueComponent(pixel - width + 1)
        if (x > 0 && pixel + width < candidate.length) enqueueComponent(pixel + width - 1)
        if (x + 1 < width && pixel + width < candidate.length) enqueueComponent(pixel + width + 1)
      }

      const area = tail
      const boxWidth = maxX - minX + 1
      const boxHeight = maxY - minY + 1
      const aspectRatio = Math.max(boxWidth / boxHeight, boxHeight / boxWidth)
      const fillRatio = area / (boxWidth * boxHeight)
      const average = sum / area
      const deviation = Math.sqrt(Math.max(0, sumSquares / area - average * average))
      const isGraduatedBlob =
        area >= minimumArea &&
        area <= maximumArea &&
        Math.min(boxWidth, boxHeight) >= minimumSpan &&
        aspectRatio <= 12 &&
        fillRatio >= 0.2 &&
        maximumLight >= 245 &&
        maximumLight - minimumLight >= 28 &&
        deviation >= 7 &&
        shoulderPixels / area >= 0.18
      if (!isGraduatedBlob) continue
      regions.push({ minX, maxX, minY, maxY })
      for (let index = 0; index < tail; index += 1) {
        recoverable[queue[index]] = 1
        recoverableCount += 1
      }
    }
    return {
      data: recoverable,
      width,
      height,
      count: recoverableCount,
      regions,
      source: analysis,
    }
  } catch (error) {
    analysis.delete()
    throw error
  }
}

function applyGlareReduction(cv: CV, source: Mat) {
  const highlight = recoverableHighlightMask(cv, source)
  const background = new cv.Mat()
  try {
    // Most scans do not contain a recoverable highlight. Detecting first avoids
    // a large full-resolution blur that used to dominate every smart export.
    if (highlight.count === 0) return

    // Glare is low-frequency, so its colour-aware background can be estimated
    // on the analysis image and sampled back into only the affected regions.
    const fullKernel = scaledOdd(Math.min(source.cols, source.rows) / 5, 61, 201)
    const analysisScale = Math.min(highlight.width / source.cols, highlight.height / source.rows)
    const kernelSize = scaledOdd(fullKernel * analysisScale, 9, 101)
    cv.GaussianBlur(highlight.source, background, new cv.Size(kernelSize, kernelSize), 0)
    const pixels = source.data
    const scaleX = highlight.width / source.cols
    const scaleY = highlight.height / source.rows
    for (const region of highlight.regions) {
      const startX = Math.max(0, Math.floor(region.minX / scaleX))
      const endX = Math.min(source.cols - 1, Math.ceil((region.maxX + 1) / scaleX) - 1)
      const startY = Math.max(0, Math.floor(region.minY / scaleY))
      const endY = Math.min(source.rows - 1, Math.ceil((region.maxY + 1) / scaleY) - 1)
      for (let y = startY; y <= endY; y += 1) {
        const sampleY = clamp((y + 0.5) * scaleY - 0.5, 0, highlight.height - 1)
        const top = Math.floor(sampleY)
        const bottom = Math.min(highlight.height - 1, top + 1)
        const mixY = sampleY - top
        const maskY = Math.min(highlight.height - 1, Math.floor(y * scaleY))
        for (let x = startX; x <= endX; x += 1) {
          const maskX = Math.min(highlight.width - 1, Math.floor(x * scaleX))
          if (!highlight.data[maskY * highlight.width + maskX]) continue
          const index = (y * source.cols + x) * 4
          const red = pixels[index]
          const green = pixels[index + 1]
          const blue = pixels[index + 2]
          const light = pixelLuma(red, green, blue)
          const sampleX = clamp((x + 0.5) * scaleX - 0.5, 0, highlight.width - 1)
          const left = Math.floor(sampleX)
          const right = Math.min(highlight.width - 1, left + 1)
          const mixX = sampleX - left
          const topLeft = (top * highlight.width + left) * 4
          const topRight = (top * highlight.width + right) * 4
          const bottomLeft = (bottom * highlight.width + left) * 4
          const bottomRight = (bottom * highlight.width + right) * 4
          const sampleChannel = (channel: number) =>
            mix(
              mix(background.data[topLeft + channel], background.data[topRight + channel], mixX),
              mix(
                background.data[bottomLeft + channel],
                background.data[bottomRight + channel],
                mixX,
              ),
              mixY,
            )
          const localRed = sampleChannel(0)
          const localGreen = sampleChannel(1)
          const localBlue = sampleChannel(2)
          const localLight = pixelLuma(localRed, localGreen, localBlue)
          const saturation = Math.max(red, green, blue) - Math.min(red, green, blue)
          const excess = light - localLight
          const strength =
            smoothstep(198, 244, light) *
            smoothstep(4, 38, excess) *
            (1 - smoothstep(28, 82, saturation))
          if (strength < 0.01) continue
          const targetLight = localLight + Math.min(7, Math.max(0, excess) * 0.12)
          const reconstructedRed = targetLight + (localRed - localLight) * 1.18
          const reconstructedGreen = targetLight + (localGreen - localLight) * 1.18
          const reconstructedBlue = targetLight + (localBlue - localLight) * 1.18
          const blend = strength * 0.94
          pixels[index] = clamp(mix(red, reconstructedRed, blend), 0, 255)
          pixels[index + 1] = clamp(mix(green, reconstructedGreen, blend), 0, 255)
          pixels[index + 2] = clamp(mix(blue, reconstructedBlue, blend), 0, 255)
        }
      }
    }
  } finally {
    background.delete()
    highlight.source.delete()
  }
}

function estimatePaperWhitePoint(data: Uint8Array) {
  const histogram = new Uint32Array(256)
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    histogram[Math.round(pixelLuma(data[index], data[index + 1], data[index + 2]))] += 1
    count += 1
  }
  const lower = histogramPercentile(histogram, count, 0.62)
  const upper = histogramPercentile(histogram, count, 0.95)
  let red = 0
  let green = 0
  let blue = 0
  let samples = 0
  for (let index = 0; index < data.length; index += 4) {
    const r = data[index]
    const g = data[index + 1]
    const b = data[index + 2]
    const light = pixelLuma(r, g, b)
    const saturation = Math.max(r, g, b) - Math.min(r, g, b)
    if (light < lower || light > upper || saturation > 72) continue
    red += r
    green += g
    blue += b
    samples += 1
  }
  if (!samples) return { red: upper, green: upper, blue: upper, luma: upper }
  const result = {
    red: red / samples,
    green: green / samples,
    blue: blue / samples,
    luma: 0,
  }
  result.luma = pixelLuma(result.red, result.green, result.blue)
  return result
}

function balancedLumaHistogram(
  data: Uint8Array,
  redScale: number,
  greenScale: number,
  blueScale: number,
) {
  const histogram = new Uint32Array(256)
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    const light = pixelLuma(
      clamp(data[index] * redScale, 0, 255),
      clamp(data[index + 1] * greenScale, 0, 255),
      clamp(data[index + 2] * blueScale, 0, 255),
    )
    histogram[Math.round(light)] += 1
    count += 1
  }
  return { histogram, count }
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

function applyClassicalShadowRemoval(cv: CV, source: Mat, shadowStrength: number) {
  const illumination = estimatePaperIllumination(cv, source)
  const gray = new cv.Mat()
  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY)
    const dark = percentile(illumination.data, 0.12)
    const paper = percentile(illumination.data, 0.92)
    const variation = paper - dark
    // A flat page should remain flat. This prevents needless colour and exposure shifts.
    if (variation < 4) return
    const normalizedStrength = clamp(shadowStrength, 0, 100) / 100
    const blend = clamp(0.3 + Math.sqrt(normalizedStrength) * 0.77, 0, 1)
    const target = Math.max(
      paper,
      percentile(gray.data, 0.9),
      variation > 22 && paper < 184 ? 184 : paper,
    )
    const pixels = source.data
    for (let pixel = 0, index = 0; pixel < illumination.data.length; pixel += 1, index += 4) {
      const background = Math.max(36, illumination.data[pixel])
      // Blend toward direct shade normalization. Applying the ratio from the
      // low-frequency illumination map preserves local ink contrast while
      // flattening broad gradients and cast shadows.
      const ratio = clamp(target / background, 1, 2.4)
      const gain = 1 + (ratio - 1) * blend
      pixels[index] = clamp(pixels[index] * gain, 0, 255)
      pixels[index + 1] = clamp(pixels[index + 1] * gain, 0, 255)
      pixels[index + 2] = clamp(pixels[index + 2] * gain, 0, 255)
    }
  } finally {
    illumination.delete()
    gray.delete()
  }
}

function applyBrightnessBalance(cv: CV, source: Mat, strength: number) {
  const normalizedStrength = clamp(strength, 0, 100) / 100
  if (normalizedStrength === 0) return

  const illumination = estimatePaperIllumination(cv, source)
  try {
    const dark = percentile(illumination.data, 0.15)
    const bright = percentile(illumination.data, 0.85)
    // Avoid shifting scans that already have even lighting. Exposure changes
    // on an even page belong to the global brightness adjustment instead.
    if (bright - dark < 6) return

    // The midpoint of both lighting extremes stays neutral even when a bright
    // hotspot covers most of the page. A median target would otherwise match
    // that dominant bright area and only lift the remaining shadows.
    const target = (dark + bright) / 2
    const blend = Math.sqrt(normalizedStrength)
    const pixels = source.data
    for (let pixel = 0, index = 0; pixel < illumination.data.length; pixel += 1, index += 4) {
      const background = Math.max(24, illumination.data[pixel])
      // Unlike shadow removal, this correction works in both directions:
      // shaded areas are lifted while overly lit areas are reduced toward the
      // shared target exposure. Matching RGB gains preserve the original hue.
      const ratio = clamp(target / background, 0.72, 1.8)
      const gain = 1 + (ratio - 1) * blend
      pixels[index] = clamp(pixels[index] * gain, 0, 255)
      pixels[index + 1] = clamp(pixels[index + 1] * gain, 0, 255)
      pixels[index + 2] = clamp(pixels[index + 2] * gain, 0, 255)
    }
  } finally {
    illumination.delete()
  }
}

function applyDocumentColorEnhancement(
  cv: CV,
  output: Mat,
  flattenPaper: boolean,
  whiteningStrength = DEFAULT_WHITENING_STRENGTH,
) {
  // Market-style colour modes clean the paper as well as boosting coloured ink.
  // They perform their own base flattening only when the shadow category is off;
  // otherwise they consume the selected light correction without stacking it.
  if (flattenPaper) applyClassicalShadowRemoval(cv, output, 90)
  const data = output.data
  const whitePoint = estimatePaperWhitePoint(data)
  const redScale = clamp(whitePoint.luma / Math.max(1, whitePoint.red), 0.84, 1.2)
  const greenScale = clamp(whitePoint.luma / Math.max(1, whitePoint.green), 0.84, 1.2)
  const blueScale = clamp(whitePoint.luma / Math.max(1, whitePoint.blue), 0.84, 1.2)
  const { histogram, count } = balancedLumaHistogram(data, redScale, greenScale, blueScale)
  const blackPoint = histogramPercentile(histogram, count, 0.015)
  const paperPoint = Math.max(blackPoint + 48, histogramPercentile(histogram, count, 0.86))
  const range = paperPoint - blackPoint
  const normalizedWhitening = clamp(whiteningStrength, 0, 100)
  const whiteningAmount = clamp(normalizedWhitening / DEFAULT_WHITENING_STRENGTH, 0, 1)
  const extraWhitening = clamp(
    (normalizedWhitening - DEFAULT_WHITENING_STRENGTH) / (100 - DEFAULT_WHITENING_STRENGTH),
    0,
    1,
  )
  const neutralizationAmount = whiteningAmount

  for (let index = 0; index < data.length; index += 4) {
    const red = clamp(data[index] * redScale, 0, 255)
    const green = clamp(data[index + 1] * greenScale, 0, 255)
    const blue = clamp(data[index + 2] * blueScale, 0, 255)
    const light = pixelLuma(red, green, blue)
    const normalized = clamp((light - blackPoint) / range, 0, 1)
    const saturation = Math.max(red, green, blue) - Math.min(red, green, blue)
    const paperMask = smoothstep(0.76, 0.98, normalized) * (1 - smoothstep(20, 74, saturation))
    const enhancedLight = 8 + 240 * normalized ** 0.8
    const preservedPaperLight = mix(enhancedLight, light, paperMask)
    const defaultPaperLight = mix(
      enhancedLight,
      248,
      paperMask * (DEFAULT_WHITENING_STRENGTH / 100),
    )
    let targetLight = mix(preservedPaperLight, defaultPaperLight, whiteningAmount)
    targetLight = mix(targetLight, 250, paperMask * extraWhitening)
    const chromaScale = mix(1.17, 0.08, paperMask * neutralizationAmount)
    data[index] = clamp(targetLight + (red - light) * chromaScale, 0, 255)
    data[index + 1] = clamp(targetLight + (green - light) * chromaScale, 0, 255)
    data[index + 2] = clamp(targetLight + (blue - light) * chromaScale, 0, 255)
  }
}

function applyGrayscaleDocument(cv: CV, output: Mat, flattenPaper: boolean) {
  const gray = new cv.Mat()
  const denoised = new cv.Mat()
  try {
    if (flattenPaper) applyClassicalShadowRemoval(cv, output, 92)
    cv.cvtColor(output, gray, cv.COLOR_RGBA2GRAY)
    cv.bilateralFilter(gray, denoised, 5, 22, 4)
    const blackPoint = percentile(denoised.data, 0.018)
    const paperPoint = Math.max(blackPoint + 48, percentile(denoised.data, 0.86))
    const range = paperPoint - blackPoint
    for (let index = 0; index < denoised.data.length; index += 1) {
      const normalized = clamp((denoised.data[index] - blackPoint) / range, 0, 1)
      denoised.data[index] = clamp(6 + 243 * normalized ** 0.82, 0, 255)
    }
    cv.cvtColor(denoised, output, cv.COLOR_GRAY2RGBA)
  } finally {
    gray.delete()
    denoised.delete()
  }
}

function applyBlackWhiteDocument(cv: CV, output: Mat, flattenPaper: boolean) {
  const gray = new cv.Mat()
  const denoised = new cv.Mat()
  const normalized = new cv.Mat()
  const adaptive = new cv.Mat()
  try {
    if (flattenPaper) applyClassicalShadowRemoval(cv, output, 100)
    cv.cvtColor(output, gray, cv.COLOR_RGBA2GRAY)
    cv.bilateralFilter(gray, denoised, 5, 24, 4)
    normalized.create(denoised.rows, denoised.cols, cv.CV_8UC1)
    const blackPoint = percentile(denoised.data, 0.012)
    const paperPoint = Math.max(blackPoint + 52, percentile(denoised.data, 0.86))
    const range = paperPoint - blackPoint
    for (let index = 0; index < denoised.data.length; index += 1) {
      const value = clamp((denoised.data[index] - blackPoint) / range, 0, 1)
      normalized.data[index] = clamp(5 + 248 * value ** 0.88, 0, 255)
    }
    const blockSize = scaledOdd(Math.min(output.cols, output.rows) / 14, 41, 121)
    cv.adaptiveThreshold(
      normalized,
      adaptive,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY,
      blockSize,
      12,
    )
    // Adaptive thresholding alone treats a large uniform red stamp as paper.
    // Combine it with the normalized global tone so coloured document content
    // remains visible while faint background texture stays white.
    for (let index = 0; index < adaptive.data.length; index += 1) {
      const value = normalized.data[index]
      adaptive.data[index] = value < 194 || (adaptive.data[index] === 0 && value < 234) ? 0 : 255
    }
    cv.cvtColor(adaptive, output, cv.COLOR_GRAY2RGBA)
  } finally {
    gray.delete()
    denoised.delete()
    normalized.delete()
    adaptive.delete()
  }
}

function applyColorEffect(
  cv: CV,
  output: Mat,
  effect: EnhancementEffects['color'],
  flattenPaper: boolean,
  whiteningStrength: number,
) {
  if (effect === 'enhanced-color') {
    applyDocumentColorEnhancement(cv, output, flattenPaper, whiteningStrength)
  } else if (effect === 'grayscale') {
    applyGrayscaleDocument(cv, output, flattenPaper)
  } else if (effect === 'black-white') {
    applyBlackWhiteDocument(cv, output, flattenPaper)
  }
}

function applyDetailEnhancement(cv: CV, output: Mat, strength: number) {
  const amount = 0.28 + (clamp(strength, 0, 100) / 100) * 0.92
  const blur = new cv.Mat()
  try {
    cv.GaussianBlur(output, blur, new cv.Size(0, 0), 0.9)
    const pixels = output.data
    const blurred = blur.data
    for (let index = 0; index < pixels.length; index += 4) {
      const light = pixelLuma(pixels[index], pixels[index + 1], pixels[index + 2])
      const blurredLight = pixelLuma(blurred[index], blurred[index + 1], blurred[index + 2])
      const edgeMask = smoothstep(1.6, 13, Math.abs(light - blurredLight))
      if (edgeMask < 0.01) continue
      for (let channel = 0; channel < 3; channel += 1) {
        const detail = clamp(pixels[index + channel] - blurred[index + channel], -16, 16)
        pixels[index + channel] = clamp(
          pixels[index + channel] + detail * amount * edgeMask,
          0,
          255,
        )
      }
    }
  } finally {
    blur.delete()
  }
}

export function processEffects(
  cv: CV,
  source: Mat,
  effects: EnhancementEffects,
  adjustments: EnhancementSettings,
) {
  const output = source.clone()
  try {
    const glareHandledBeforeBalance = effects.shadow === 'balance' && effects.glare === 'deglare'
    // Preserve highlight detection by repairing glare before brightness
    // balancing can lower its luminance below the recovery threshold.
    if (glareHandledBeforeBalance) {
      applyGlareReduction(cv, output)
    }
    if (effects.shadow === 'deshadow') {
      applyClassicalShadowRemoval(cv, output, adjustments.shadowStrength)
    } else if (effects.shadow === 'balance') {
      applyBrightnessBalance(cv, output, adjustments.shadowStrength)
    }
    if (effects.glare === 'deglare' && !glareHandledBeforeBalance) {
      applyGlareReduction(cv, output)
    }
    applyToneAdjustments(output, adjustments)
    applyColorEffect(
      cv,
      output,
      effects.color,
      effects.shadow === 'none',
      adjustments.whiteningStrength,
    )
    if (effects.detail === 'sharpen') {
      applyDetailEnhancement(cv, output, adjustments.sharpness)
    }
    return output
  } catch (error) {
    output.delete()
    throw error
  }
}
