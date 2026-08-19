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
  const candidate = new cv.Mat()
  const labels = new cv.Mat()
  const stats = new cv.Mat()
  const centroids = new cv.Mat()
  try {
    const scale = Math.min(1, 640 / Math.max(source.cols, source.rows))
    const width = Math.max(1, Math.round(source.cols * scale))
    const height = Math.max(1, Math.round(source.rows * scale))
    cv.resize(source, analysis, new cv.Size(width, height), 0, 0, cv.INTER_AREA)
    candidate.create(height, width, cv.CV_8UC1)
    let analysisData = analysis.data
    const candidateData = candidate.data
    for (let pixel = 0, index = 0; pixel < candidateData.length; pixel += 1, index += 4) {
      const red = analysisData[index]
      const green = analysisData[index + 1]
      const blue = analysisData[index + 2]
      const light = pixelLuma(red, green, blue)
      const saturation = Math.max(red, green, blue) - Math.min(red, green, blue)
      candidateData[pixel] = light >= 194 && saturation <= 86 ? 1 : 0
    }

    const labelCount = cv.connectedComponentsWithStats(
      candidate,
      labels,
      stats,
      centroids,
      8,
      cv.CV_32S,
    )
    const labelData = labels.data32S
    const statsData = stats.data32S
    // OpenCV may grow the WASM heap while labeling. Refresh the view before
    // reading the analysis pixels again.
    analysisData = analysis.data

    // A bright page is normally connected to the crop boundary. Excluding that
    // component prevents paper margins from being pulled toward nearby ink.
    const exterior = new Uint8Array(labelCount)
    for (let x = 0; x < width; x += 1) {
      exterior[labelData[x]] = 1
      exterior[labelData[(height - 1) * width + x]] = 1
    }
    for (let y = 1; y < height - 1; y += 1) {
      const row = y * width
      exterior[labelData[row]] = 1
      exterior[labelData[row + width - 1]] = 1
    }

    // Only broad, graduated highlight blobs are recoverable glare. Connected
    // component geometry and tone spread protect legitimate white text, logos,
    // barcodes and solid design elements inside coloured regions.
    const minimumArea = Math.max(32, Math.round(labelData.length * 0.00025))
    const maximumArea = Math.round(labelData.length * 0.12)
    const minimumSpan = Math.max(6, Math.round(Math.min(width, height) * 0.018))
    const eligible = new Uint8Array(labelCount)
    for (let label = 1; label < labelCount; label += 1) {
      if (exterior[label]) continue
      const offset = label * 5
      const boxWidth = statsData[offset + 2]
      const boxHeight = statsData[offset + 3]
      const area = statsData[offset + 4]
      const aspectRatio = Math.max(boxWidth / boxHeight, boxHeight / boxWidth)
      const fillRatio = area / (boxWidth * boxHeight)
      if (
        area >= minimumArea &&
        area <= maximumArea &&
        Math.min(boxWidth, boxHeight) >= minimumSpan &&
        aspectRatio <= 12 &&
        fillRatio >= 0.2
      ) {
        eligible[label] = 1
      }
    }

    const sums = new Float64Array(labelCount)
    const sumSquares = new Float64Array(labelCount)
    const minimumLights = new Float64Array(labelCount)
    minimumLights.fill(255)
    const maximumLights = new Float64Array(labelCount)
    const shoulderPixels = new Uint32Array(labelCount)
    for (let pixel = 0, index = 0; pixel < labelData.length; pixel += 1, index += 4) {
      const label = labelData[pixel]
      if (!eligible[label]) continue
      const light = pixelLuma(analysisData[index], analysisData[index + 1], analysisData[index + 2])
      sums[label] += light
      sumSquares[label] += light * light
      minimumLights[label] = Math.min(minimumLights[label], light)
      maximumLights[label] = Math.max(maximumLights[label], light)
      if (light >= 202 && light <= 240) shoulderPixels[label] += 1
    }

    const accepted = new Uint8Array(labelCount)
    const regions: HighlightRegion[] = []
    let recoverableCount = 0
    for (let label = 1; label < labelCount; label += 1) {
      if (!eligible[label]) continue
      const offset = label * 5
      const area = statsData[offset + 4]
      const average = sums[label] / area
      const deviation = Math.sqrt(Math.max(0, sumSquares[label] / area - average * average))
      const isGraduatedBlob =
        maximumLights[label] >= 245 &&
        maximumLights[label] - minimumLights[label] >= 28 &&
        deviation >= 7 &&
        shoulderPixels[label] / area >= 0.18
      if (!isGraduatedBlob) continue
      accepted[label] = 1
      const minX = statsData[offset]
      const minY = statsData[offset + 1]
      const boxWidth = statsData[offset + 2]
      const boxHeight = statsData[offset + 3]
      regions.push({ minX, maxX: minX + boxWidth - 1, minY, maxY: minY + boxHeight - 1 })
      recoverableCount += area
    }

    const recoverable = new Uint8Array(labelData.length)
    for (let pixel = 0; pixel < labelData.length; pixel += 1) {
      recoverable[pixel] = accepted[labelData[pixel]]
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
  } finally {
    candidate.delete()
    labels.delete()
    stats.delete()
    centroids.delete()
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
    const backgroundPixels = background.data
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
              mix(backgroundPixels[topLeft + channel], backgroundPixels[topRight + channel], mixX),
              mix(
                backgroundPixels[bottomLeft + channel],
                backgroundPixels[bottomRight + channel],
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
    const combinedData = combined.data
    const closeData = closes.map((mat) => mat.data)
    for (let index = 0; index < combinedData.length; index += 1) {
      // The large scale bridges broad cast shadows; the smaller scales reduce edge halos.
      combinedData[index] = Math.max(
        closeData[0][index] * 0.94,
        closeData[1][index] * 0.98,
        closeData[2][index],
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
    const illuminationData = illumination.data
    for (let pixel = 0, index = 0; pixel < illuminationData.length; pixel += 1, index += 4) {
      const background = Math.max(36, illuminationData[pixel])
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
    const illuminationData = illumination.data
    for (let pixel = 0, index = 0; pixel < illuminationData.length; pixel += 1, index += 4) {
      const background = Math.max(24, illuminationData[pixel])
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
    const denoisedData = denoised.data
    const blackPoint = percentile(denoisedData, 0.018)
    const paperPercentile = percentile(denoisedData, 0.86)
    const paperPoint = Math.max(blackPoint + 48, paperPercentile)
    const range = paperPoint - blackPoint
    const toneMap = new Uint8Array(256)
    for (let value = 0; value < toneMap.length; value += 1) {
      const normalized = clamp((value - blackPoint) / range, 0, 1)
      toneMap[value] = clamp(6 + 243 * normalized ** 0.82, 0, 255)
    }
    for (let index = 0; index < denoisedData.length; index += 1) {
      denoisedData[index] = toneMap[denoisedData[index]]
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
    const denoisedData = denoised.data
    normalized.create(denoised.rows, denoised.cols, cv.CV_8UC1)
    const normalizedData = normalized.data
    const blackPoint = percentile(denoisedData, 0.012)
    const paperPoint = Math.max(blackPoint + 52, percentile(denoisedData, 0.86))
    const range = paperPoint - blackPoint
    const toneMap = new Uint8Array(256)
    for (let value = 0; value < toneMap.length; value += 1) {
      const normalized = clamp((value - blackPoint) / range, 0, 1)
      toneMap[value] = clamp(5 + 248 * normalized ** 0.88, 0, 255)
    }
    for (let index = 0; index < denoisedData.length; index += 1) {
      normalizedData[index] = toneMap[denoisedData[index]]
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
    const thresholdInput = normalized.data
    const adaptiveData = adaptive.data
    for (let index = 0; index < adaptiveData.length; index += 1) {
      const value = thresholdInput[index]
      adaptiveData[index] = value < 194 || (adaptiveData[index] === 0 && value < 234) ? 0 : 255
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

function applyLightingEffects(
  cv: CV,
  output: Mat,
  effects: EnhancementEffects,
  adjustments: EnhancementSettings,
) {
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
}

function applyPostLightingEffects(
  cv: CV,
  output: Mat,
  effects: EnhancementEffects,
  adjustments: EnhancementSettings,
) {
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
}

function processCopy(cv: CV, source: Mat, operation: (output: Mat) => void) {
  // This OpenCV.js build exposes clone() as shared pixel storage. copyTo()
  // keeps cached pipeline stages immutable while later effects edit in place.
  const output = new cv.Mat()
  source.copyTo(output)
  try {
    operation(output)
    return output
  } catch (error) {
    output.delete()
    throw error
  }
}

export function createLightingResult(
  cv: CV,
  source: Mat,
  effects: EnhancementEffects,
  adjustments: EnhancementSettings,
) {
  return processCopy(cv, source, (output) => applyLightingEffects(cv, output, effects, adjustments))
}

export function processEffectsFromLighting(
  cv: CV,
  source: Mat,
  effects: EnhancementEffects,
  adjustments: EnhancementSettings,
) {
  return processCopy(cv, source, (output) =>
    applyPostLightingEffects(cv, output, effects, adjustments),
  )
}

export function processEffects(
  cv: CV,
  source: Mat,
  effects: EnhancementEffects,
  adjustments: EnhancementSettings,
) {
  return processCopy(cv, source, (output) => {
    applyLightingEffects(cv, output, effects, adjustments)
    applyPostLightingEffects(cv, output, effects, adjustments)
  })
}
