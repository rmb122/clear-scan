import JSZip from 'jszip'
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { ORIGINAL_EFFECTS, type ScanPage } from '@/lib/types'
import { makePage } from './scan-fixtures'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export async function makeWatermarkPage(overrides: Partial<ScanPage> = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = 800
  canvas.height = 1000
  const context = canvas.getContext('2d')!
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#666666'
  for (let row = 0; row < 8; row += 1) {
    context.fillRect(100, 180 + row * 80, 500, 6)
  }
  const source = await new Promise<Blob>((resolve) =>
    canvas.toBlob((blob) => resolve(blob!), 'image/png'),
  )
  return makePage({
    source,
    width: canvas.width,
    height: canvas.height,
    effects: { ...ORIGINAL_EFFECTS },
    corners: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    ...overrides,
  })
}

export function watermarkPixels(canvas: HTMLCanvasElement, contents: Bounds[] = []) {
  const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const expanded = contents.map((content) => {
    const padding = Math.min(content.width, content.height) * 0.1
    return {
      x: content.x - padding,
      y: content.y - padding,
      width: content.width + padding * 2,
      height: content.height + padding * 2,
    }
  })
  // Include partially covered boundary pixels when checking fractional rectangles.
  const intersects = (x: number, y: number, bounds: Bounds) =>
    x + 1 > bounds.x &&
    y + 1 > bounds.y &&
    x < bounds.x + bounds.width &&
    y < bounds.y + bounds.height
  let red = 0
  let neutralDark = 0
  let outsideContent = 0
  let outsideExpansion = 0
  let maxAlpha = 0
  for (let index = 0; index < pixels.length; index += 4) {
    if (
      pixels[index + 3] > 0 &&
      pixels[index] < 160 &&
      Math.abs(pixels[index] - pixels[index + 1]) < 10 &&
      Math.abs(pixels[index] - pixels[index + 2]) < 10
    )
      neutralDark += 1
    if (
      pixels[index] <= pixels[index + 1] + 40 ||
      pixels[index] <= pixels[index + 2] + 40 ||
      pixels[index + 3] === 0
    )
      continue
    const x = (index / 4) % canvas.width
    const y = Math.floor(index / 4 / canvas.width)
    red += 1
    maxAlpha = Math.max(maxAlpha, pixels[index + 3])
    if (!contents.some((bounds) => intersects(x, y, bounds))) outsideContent += 1
    if (!expanded.some((bounds) => intersects(x, y, bounds))) outsideExpansion += 1
  }
  return {
    width: canvas.width,
    height: canvas.height,
    red,
    neutralDark,
    outsideContent,
    outsideExpansion,
    maxAlpha,
  }
}

export async function watermarkBlobPixels(blob: Blob, contents?: Bounds[]) {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    return watermarkPixels(canvas, contents)
  } finally {
    bitmap.close()
  }
}

export async function watermarkZipPixels(blob: Blob) {
  const archive = await JSZip.loadAsync(blob)
  return Promise.all(
    Object.values(archive.files).map(async (entry) =>
      watermarkBlobPixels(await entry.async('blob')),
    ),
  )
}

export async function watermarkPdfImages(blob: Blob, contents: Bounds[]) {
  const pdf = await PDFDocument.load(await blob.arrayBuffer())
  const images = []
  // Inspect every image object, including images not referenced by a page.
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (
      !(object instanceof PDFRawStream) ||
      object.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')
    )
      continue
    const filter = object.dict.get(PDFName.of('Filter'))?.toString()
    images.push({
      filter,
      hasMask: object.dict.has(PDFName.of('SMask')),
      pixels:
        filter === '/DCTDecode'
          ? await watermarkBlobPixels(
              new Blob([new Uint8Array(object.getContents())], { type: 'image/jpeg' }),
              contents,
            )
          : undefined,
    })
  }
  return { pages: pdf.getPages().map((page) => page.getSize()), images }
}
