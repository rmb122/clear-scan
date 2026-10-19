import { fitWithin } from './geometry'
import { A4_MM, getIdCardSheetLayout, type IdCardSize } from './id-card-layout'
import { scannerClient } from './scanner-client'
import type { ScanPage, ScanProject, WatermarkSettings } from './types'
import { drawWatermark, hasWatermark } from './watermark'
import { sanitizeFileName } from './utils'
import { messages } from './i18n'

export type ExportFormat = 'jpg' | 'png' | 'pdf' | 'zip'
export type PdfLayout = 'content' | 'a4'

interface ExportResult {
  blob: Blob
  fileName: string
}

interface RenderedPage {
  blob: Blob
  width: number
  height: number
}

const A4_POINTS = { width: (A4_MM.width / 25.4) * 72, height: (A4_MM.height / 25.4) * 72 }
const A4_PIXELS = { width: 2480, height: 3508 }

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: 'image/jpeg' | 'image/png',
  quality = 0.94,
) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(messages.exportImageFailed))),
      mimeType,
      quality,
    )
  })
}

async function renderScanPage(
  page: ScanPage,
  mimeType: 'image/jpeg' | 'image/png',
  watermark?: WatermarkSettings,
) {
  return scannerClient.render(
    page,
    { maxEdge: 3000, mimeType, quality: 0.94, watermark },
    { intent: 'export' },
  )
}

async function composeIdCard(
  pages: ScanPage[],
  mimeType: 'image/jpeg' | 'image/png',
  size: IdCardSize,
  watermark?: WatermarkSettings,
  onProgress?: (value: number, label: string) => void,
) {
  const front = pages.find((page) => page.role === 'front')
  const back = pages.find((page) => page.role === 'back')
  if (!front || !back) throw new Error(messages.idCardIncomplete)

  onProgress?.(15, messages.processingFront)
  const frontImage = await renderScanPage(front, mimeType)
  onProgress?.(48, messages.processingBack)
  const backImage = await renderScanPage(back, mimeType)
  const [frontBitmap, backBitmap] = await Promise.all([
    createImageBitmap(frontImage.blob),
    createImageBitmap(backImage.blob),
  ])

  const canvas = document.createElement('canvas')
  canvas.width = A4_PIXELS.width
  canvas.height = A4_PIXELS.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error(messages.idCardCanvasFailed)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  const layout = getIdCardSheetLayout(canvas.width, canvas.height, size)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    frontBitmap,
    layout.front.x,
    layout.front.y,
    layout.front.width,
    layout.front.height,
  )
  context.drawImage(backBitmap, layout.back.x, layout.back.y, layout.back.width, layout.back.height)
  frontBitmap.close()
  backBitmap.close()
  drawWatermark(context, layout.front, watermark, [layout.front, layout.back])

  onProgress?.(85, messages.composingA4)
  const blob = await canvasToBlob(canvas, mimeType)
  return { blob, width: canvas.width, height: canvas.height }
}

async function createPdf(
  renderedPages: Iterable<RenderedPage> | AsyncIterable<RenderedPage>,
  layout: PdfLayout,
  fullPage = false,
) {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.setProducer(messages.pdfProducer)
  pdf.setCreator(messages.appName)
  pdf.setCreationDate(new Date())

  for await (const rendered of renderedPages) {
    const bytes = await rendered.blob.arrayBuffer()
    const image =
      rendered.blob.type === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes)
    if (layout === 'a4') {
      const page = pdf.addPage([A4_POINTS.width, A4_POINTS.height])
      const margin = fullPage ? 0 : 24
      // A composed sheet already includes its whitespace and physical sizing.
      const placement = fullPage
        ? { x: 0, y: 0, ...A4_POINTS }
        : fitWithin(
            rendered.width,
            rendered.height,
            A4_POINTS.width - margin * 2,
            A4_POINTS.height - margin * 2,
          )
      page.drawImage(image, {
        x: placement.x + margin,
        y: A4_POINTS.height - placement.y - placement.height - margin,
        width: placement.width,
        height: placement.height,
      })
    } else {
      const maxSide = 792
      const scale = Math.min(1, maxSide / Math.max(rendered.width, rendered.height))
      const width = rendered.width * scale
      const height = rendered.height * scale
      const page = pdf.addPage([width, height])
      page.drawImage(image, { x: 0, y: 0, width, height })
    }
    // Finish embedding now so pdf-lib releases its decoder before the next page.
    await image.embed()
  }

  const bytes = await pdf.save()
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return new Blob([buffer], { type: 'application/pdf' })
}

async function composeA4Page(rendered: RenderedPage, watermark?: WatermarkSettings) {
  const canvas = document.createElement('canvas')
  canvas.width = A4_PIXELS.width
  canvas.height = A4_PIXELS.height
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(rendered.blob)
    const context = canvas.getContext('2d')
    if (!context) throw new Error(messages.renderFailed)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const margin = 24
    const placement = fitWithin(
      rendered.width,
      rendered.height,
      A4_POINTS.width - margin * 2,
      A4_POINTS.height - margin * 2,
    )
    const scaleX = canvas.width / A4_POINTS.width
    const scaleY = canvas.height / A4_POINTS.height
    const content = {
      x: (placement.x + margin) * scaleX,
      y: (placement.y + margin) * scaleY,
      width: placement.width * scaleX,
      height: placement.height * scaleY,
    }
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, content.x, content.y, content.width, content.height)
    drawWatermark(context, content, watermark)
    // Only this flattened image enters the PDF, including the marked whitespace.
    const blob = await canvasToBlob(canvas, 'image/jpeg')
    return { blob, width: canvas.width, height: canvas.height }
  } finally {
    bitmap?.close()
    canvas.width = 0
    canvas.height = 0
  }
}

async function* renderPdfPages(
  pages: ScanPage[],
  watermark: WatermarkSettings | undefined,
  fullPage: boolean,
  onProgress?: (value: number, label: string) => void,
) {
  for (const [index, page] of pages.entries()) {
    onProgress?.(Math.round((index / pages.length) * 82), messages.processingPageNumber(index + 1))
    // A lossless intermediate avoids encoding JPEG twice when composing an A4 sheet.
    const rendered = await renderScanPage(
      page,
      fullPage ? 'image/png' : 'image/jpeg',
      fullPage ? undefined : watermark,
    )
    yield fullPage ? await composeA4Page(rendered, watermark) : rendered
  }
}

export async function exportProject(
  project: ScanProject,
  pages: ScanPage[],
  format: ExportFormat,
  layout: PdfLayout,
  idCardSize: IdCardSize = 'original',
  onProgress?: (value: number, label: string) => void,
): Promise<ExportResult> {
  const baseName = sanitizeFileName(project.name)
  const orderedPages = [...pages].sort((left, right) => left.order - right.order)
  if (orderedPages.length === 0) throw new Error(messages.noExportPages)

  if (project.mode === 'id-card') {
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
    const composition = await composeIdCard(
      orderedPages,
      mimeType,
      idCardSize,
      project.watermark,
      onProgress,
    )
    if (format === 'pdf') {
      const pdf = await createPdf([composition], 'a4', true)
      onProgress?.(100, messages.pdfGenerated)
      return { blob: pdf, fileName: `${baseName}.pdf` }
    }
    if (format === 'zip') throw new Error(messages.idCardExportFormat)
    onProgress?.(100, messages.combinedImageGenerated)
    return { blob: composition.blob, fileName: `${baseName}.${format}` }
  }

  if (format === 'jpg' || format === 'png') {
    if (orderedPages.length > 1) throw new Error(messages.multiPageExportFormat)
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
    onProgress?.(20, messages.processingPage)
    const rendered = await renderScanPage(orderedPages[0], mimeType, project.watermark)
    onProgress?.(100, messages.imageGenerated)
    return { blob: rendered.blob, fileName: `${baseName}.${format}` }
  }

  if (format === 'zip') {
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    for (let index = 0; index < orderedPages.length; index += 1) {
      onProgress?.(
        Math.round((index / orderedPages.length) * 85),
        messages.processingPageNumber(index + 1),
      )
      const rendered = await renderScanPage(orderedPages[index], 'image/jpeg', project.watermark)
      zip.file(`${baseName}-${String(index + 1).padStart(2, '0')}.jpg`, rendered.blob)
    }
    // JPEG pages are already compressed; deflating them again costs CPU while
    // usually saving almost no space, especially on mobile devices.
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
    onProgress?.(100, messages.zipGenerated)
    return { blob, fileName: messages.zipFileName(baseName) }
  }

  const fullPage = layout === 'a4' && hasWatermark(project.watermark)
  const renderedPages = renderPdfPages(orderedPages, project.watermark, fullPage, onProgress)
  const blob = await createPdf(renderedPages, layout, fullPage)
  onProgress?.(100, messages.pdfGenerated)
  return { blob, fileName: `${baseName}.pdf` }
}
