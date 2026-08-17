import { fitWithin } from './geometry'
import { getIdCardSheetLayout } from './id-card-layout'
import { scannerClient } from './scanner-client'
import type { ScanPage, ScanProject } from './types'
import { sanitizeFileName } from './utils'

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

const A4_POINTS = { width: 595.28, height: 841.89 }
const A4_PIXELS = { width: 2480, height: 3508 }

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: 'image/jpeg' | 'image/png',
  quality = 0.94,
) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('无法生成导出图片'))),
      mimeType,
      quality,
    )
  })
}

async function renderScanPage(page: ScanPage, mimeType: 'image/jpeg' | 'image/png') {
  return scannerClient.render(
    page,
    { maxEdge: 3000, mimeType, quality: 0.94 },
    { intent: 'export' },
  )
}

async function composeIdCard(
  pages: ScanPage[],
  mimeType: 'image/jpeg' | 'image/png',
  onProgress?: (value: number, label: string) => void,
) {
  const front = pages.find((page) => page.role === 'front')
  const back = pages.find((page) => page.role === 'back')
  if (!front || !back) throw new Error('请先完成身份证正反两面扫描')

  onProgress?.(15, '正在处理身份证人像面')
  const frontImage = await renderScanPage(front, 'image/jpeg')
  onProgress?.(48, '正在处理身份证国徽面')
  const backImage = await renderScanPage(back, 'image/jpeg')
  const [frontBitmap, backBitmap] = await Promise.all([
    createImageBitmap(frontImage.blob),
    createImageBitmap(backImage.blob),
  ])

  const canvas = document.createElement('canvas')
  canvas.width = A4_PIXELS.width
  canvas.height = A4_PIXELS.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建身份证排版画布')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  const layout = getIdCardSheetLayout(canvas.width, canvas.height)
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

  onProgress?.(85, '正在生成 A4 大图合并页')
  const blob = await canvasToBlob(canvas, mimeType)
  return { blob, width: canvas.width, height: canvas.height }
}

async function createPdf(renderedPages: RenderedPage[], layout: PdfLayout, forceA4 = false) {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.setProducer('清晰扫描 · 本地文档扫描器')
  pdf.setCreator('清晰扫描')
  pdf.setCreationDate(new Date())

  for (const rendered of renderedPages) {
    const bytes = await rendered.blob.arrayBuffer()
    const image =
      rendered.blob.type === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes)
    const useA4 = forceA4 || layout === 'a4'
    if (useA4) {
      const page = pdf.addPage([A4_POINTS.width, A4_POINTS.height])
      const placement = fitWithin(
        rendered.width,
        rendered.height,
        A4_POINTS.width - 48,
        A4_POINTS.height - 48,
      )
      page.drawImage(image, {
        x: placement.x + 24,
        y: A4_POINTS.height - placement.y - placement.height - 24,
        width: placement.width,
        height: placement.height,
      })
    } else {
      const maxSide = 792
      const scale = Math.min(1, maxSide / Math.max(rendered.width, rendered.height))
      const width = Math.max(72, rendered.width * scale)
      const height = Math.max(72, rendered.height * scale)
      const page = pdf.addPage([width, height])
      page.drawImage(image, { x: 0, y: 0, width, height })
    }
  }

  const bytes = await pdf.save()
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return new Blob([buffer], { type: 'application/pdf' })
}

export async function exportProject(
  project: ScanProject,
  pages: ScanPage[],
  format: ExportFormat,
  layout: PdfLayout,
  onProgress?: (value: number, label: string) => void,
): Promise<ExportResult> {
  const baseName = sanitizeFileName(project.name)
  const orderedPages = [...pages].sort((left, right) => left.order - right.order)
  if (orderedPages.length === 0) throw new Error('当前项目还没有可导出的页面')

  if (project.mode === 'id-card') {
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
    const composition = await composeIdCard(orderedPages, mimeType, onProgress)
    if (format === 'pdf') {
      const pdf = await createPdf([composition], 'a4', true)
      onProgress?.(100, 'PDF 已生成')
      return { blob: pdf, fileName: `${baseName}.pdf` }
    }
    if (format === 'zip') throw new Error('身份证模式请导出合并图片或 PDF')
    onProgress?.(100, '合并图片已生成')
    return { blob: composition.blob, fileName: `${baseName}.${format}` }
  }

  if (format === 'jpg' || format === 'png') {
    if (orderedPages.length > 1) throw new Error('多页项目请使用图片包 ZIP 导出')
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
    onProgress?.(20, '正在处理扫描页')
    const rendered = await renderScanPage(orderedPages[0], mimeType)
    onProgress?.(100, '图片已生成')
    return { blob: rendered.blob, fileName: `${baseName}.${format}` }
  }

  if (format === 'zip') {
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    for (let index = 0; index < orderedPages.length; index += 1) {
      onProgress?.(Math.round((index / orderedPages.length) * 85), `正在处理第 ${index + 1} 页`)
      const rendered = await renderScanPage(orderedPages[index], 'image/jpeg')
      zip.file(`${baseName}-${String(index + 1).padStart(2, '0')}.jpg`, rendered.blob)
    }
    // JPEG pages are already compressed; deflating them again costs CPU while
    // usually saving almost no space, especially on mobile devices.
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
    onProgress?.(100, '图片包已生成')
    return { blob, fileName: `${baseName}-图片包.zip` }
  }

  const renderedPages: RenderedPage[] = []
  for (let index = 0; index < orderedPages.length; index += 1) {
    onProgress?.(Math.round((index / orderedPages.length) * 82), `正在处理第 ${index + 1} 页`)
    renderedPages.push(await renderScanPage(orderedPages[index], 'image/jpeg'))
  }
  const blob = await createPdf(renderedPages, layout)
  onProgress?.(100, 'PDF 已生成')
  return { blob, fileName: `${baseName}.pdf` }
}
