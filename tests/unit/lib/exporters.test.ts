import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, PDFPage, type PDFImage } from 'pdf-lib'

const { renderMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
}))

vi.mock('@/lib/scanner-client', () => ({
  scannerClient: { render: renderMock },
}))

import { exportProject } from '@/lib/exporters'
import { DEFAULT_WATERMARK } from '@/lib/types'
import * as watermarks from '@/lib/watermark'
import { makePage, makeProject } from '../../support/scan-fixtures'

// A valid PNG keeps PDF embedding and serialization in the export tests.
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n9sAAAAASUVORK5CYII=',
    'base64',
  ),
)

const watermark = { ...DEFAULT_WATERMARK, enabled: true, text: '仅供审核使用' }

function mockA4Composition() {
  const frames: Array<{ canvas: HTMLCanvasElement; width: number; height: number }> = []
  const drawScan = vi.fn()
  const close = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    drawImage: drawScan,
  } as unknown as CanvasRenderingContext2D)
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
  ) {
    frames.push({ canvas: this, width: this.width, height: this.height })
    // A real PNG also exercises pdf-lib's decoded pixel lifecycle.
    callback(new Blob([png], { type: 'image/png' }))
  })
  const drawWatermark = vi.spyOn(watermarks, 'drawWatermark').mockImplementation(() => undefined)
  return { frames, drawScan, drawWatermark, close, encode }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('image package export', () => {
  it('keeps full render settings and stores already-compressed JPEG entries', async () => {
    renderMock.mockReset()
    renderMock.mockResolvedValue({
      blob: new Blob(['jpeg-data'], { type: 'image/jpeg' }),
      width: 3000,
      height: 2250,
    })
    const result = await exportProject(
      makeProject({ watermark }),
      [makePage({ id: 'page-2', order: 1 }), makePage()],
      'zip',
      'content',
    )

    expect(renderMock).toHaveBeenCalledTimes(2)
    expect(renderMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'page-1' }),
      { maxEdge: 3000, mimeType: 'image/jpeg', quality: 0.94, watermark },
      { intent: 'export' },
    )
    const bytes = new DataView(await result.blob.arrayBuffer())
    expect(bytes.getUint32(0, true)).toBe(0x04034b50)
    expect(bytes.getUint16(8, true)).toBe(0)
    expect(result.fileName).toBe('测试文档-图片包.zip')
  })
})

describe('ID card image export', () => {
  it.each([
    ['png', 'image/png', 'original'],
    ['jpg', 'image/jpeg', 'enlarged'],
  ] as const)(
    'uses %s throughout rendering with the selected %s encoding and %s layout',
    async (format, mimeType, size) => {
      const drawWatermark = vi
        .spyOn(watermarks, 'drawWatermark')
        .mockImplementation(() => undefined)
      renderMock.mockReset()
      renderMock.mockResolvedValue({
        blob: new Blob(['image'], { type: mimeType }),
        width: 1200,
        height: 750,
      })
      const close = vi.fn()
      const drawCard = vi.fn()
      vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close }))
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        fillRect: vi.fn(),
        drawImage: drawCard,
      } as unknown as CanvasRenderingContext2D)
      const encode = vi
        .spyOn(HTMLCanvasElement.prototype, 'toBlob')
        .mockImplementation((callback, type) => {
          callback(new Blob(['sheet'], { type }))
        })
      const result = await exportProject(
        makeProject({ name: '身份证', mode: 'id-card', watermark }),
        [
          makePage({ id: 'front', role: 'front' }),
          makePage({ id: 'back', order: 1, role: 'back' }),
        ],
        format,
        'a4',
        size,
      )

      expect(renderMock).toHaveBeenCalledTimes(2)
      for (const [page, options, request] of renderMock.mock.calls) {
        expect(['front', 'back']).toContain(page.role)
        expect(options).toEqual({ maxEdge: 3000, mimeType, quality: 0.94 })
        expect(request).toEqual({ intent: 'export' })
      }
      expect(encode).toHaveBeenCalledWith(expect.any(Function), mimeType, 0.94)
      const canvas = encode.mock.instances[0] as HTMLCanvasElement
      expect(drawCard).toHaveBeenCalledTimes(2)
      expect(drawWatermark).toHaveBeenCalledTimes(2)
      for (const [index, [, x, y, width, height]] of drawCard.mock.calls.entries()) {
        expect(drawWatermark.mock.calls[index].slice(1)).toEqual([
          { x, y, width, height },
          watermark,
        ])
      }
      for (const [, , , width] of drawCard.mock.calls) {
        expect(width / canvas.width).toBeCloseTo(size === 'original' ? 85.6 / 210 : 0.8, 6)
      }
      expect(close).toHaveBeenCalledTimes(2)
      expect(result.blob.type).toBe(mimeType)
      expect(result.fileName).toBe(`身份证.${format}`)
    },
  )
})

describe('ID card PDF export', () => {
  it('defaults to physical card dimensions without shrinking the composed A4 sheet', async () => {
    const drawWatermark = vi.spyOn(watermarks, 'drawWatermark').mockImplementation(() => undefined)
    renderMock.mockReset()
    renderMock.mockResolvedValue({
      blob: new Blob([png], { type: 'image/png' }),
      width: 1200,
      height: 750,
    })
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }))
    const drawCard = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn(),
      drawImage: drawCard,
    } as unknown as CanvasRenderingContext2D)
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((callback) => {
        callback(new Blob([png], { type: 'image/png' }))
      })
    const drawSheet = vi.spyOn(PDFPage.prototype, 'drawImage')

    const result = await exportProject(
      makeProject({ mode: 'id-card', watermark }),
      [makePage({ role: 'front' }), makePage({ id: 'back', order: 1, role: 'back' })],
      'pdf',
      'a4',
    )

    const pdf = await PDFDocument.load(await result.blob.arrayBuffer())
    expect(pdf.getPageCount()).toBe(1)
    const pageSize = pdf.getPages()[0].getSize()
    expect((pageSize.width / 72) * 25.4).toBeCloseTo(210, 6)
    expect((pageSize.height / 72) * 25.4).toBeCloseTo(297, 6)

    const canvas = encode.mock.instances[0] as HTMLCanvasElement
    const placement = drawSheet.mock.calls[0][1]!
    expect(drawCard).toHaveBeenCalledTimes(2)
    expect(drawWatermark).toHaveBeenCalledTimes(2)
    expect(drawSheet).toHaveBeenCalledTimes(1)
    for (const [, x, y, width, height] of drawCard.mock.calls) {
      const widthMm = ((width / canvas.width) * placement.width! * 25.4) / 72
      const heightMm = ((height / canvas.height) * placement.height! * 25.4) / 72
      expect(widthMm).toBeCloseTo(85.6, 6)
      expect(heightMm).toBeCloseTo(53.98, 6)
      expect(x + width / 2).toBeCloseTo(canvas.width / 2)
      expect(y).toBeGreaterThan(0)
      expect(y + height).toBeLessThan(canvas.height)
    }
    const [, , frontY, , frontHeight] = drawCard.mock.calls[0]
    const [, , backY] = drawCard.mock.calls[1]
    expect(backY).toBeGreaterThan(frontY + frontHeight)
  })
})

describe('content-sized PDF export', () => {
  it.each([
    [100, 2000, 39.6, 792],
    [2000, 100, 792, 39.6],
    [20, 40, 20, 40],
  ])('preserves the aspect ratio of a %ix%i page', async (width, height, pdfWidth, pdfHeight) => {
    renderMock.mockReset()
    renderMock.mockResolvedValue({ blob: new Blob([png], { type: 'image/png' }), width, height })
    const result = await exportProject(makeProject({ watermark }), [makePage()], 'pdf', 'content')
    expect(renderMock.mock.calls[0][1].watermark).toEqual(watermark)
    const pdf = await PDFDocument.load(await result.blob.arrayBuffer())
    const size = pdf.getPages()[0].getSize()
    expect(size.width).toBeCloseTo(pdfWidth)
    expect(size.height).toBeCloseTo(pdfHeight)
    expect(size.width / size.height).toBeCloseTo(width / height)
  })
})

describe('A4 document watermark export', () => {
  it('composes the scan and watermark into one full-page image with the existing margins', async () => {
    renderMock.mockReset()
    renderMock.mockResolvedValue({
      blob: new Blob([png], { type: 'image/png' }),
      width: 1200,
      height: 750,
    })
    const { frames, drawScan, drawWatermark, close, encode } = mockA4Composition()
    const drawImage = vi.spyOn(PDFPage.prototype, 'drawImage')
    const result = await exportProject(makeProject({ watermark }), [makePage()], 'pdf', 'a4')
    expect(renderMock.mock.calls[0][1].watermark).toBeUndefined()
    const pdf = await PDFDocument.load(await result.blob.arrayBuffer())
    const size = pdf.getPages()[0].getSize()
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(drawImage.mock.calls[0][1]).toEqual({ x: 0, y: 0, ...size })
    expect(drawScan).toHaveBeenCalledTimes(1)
    expect(drawWatermark).toHaveBeenCalledTimes(1)
    const bounds = drawWatermark.mock.calls[0][1]
    expect(drawScan.mock.calls[0].slice(1)).toEqual([
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
    ])
    const frame = frames[0]
    const contentHeight = ((size.width - 48) * 750) / 1200
    expect((bounds.x / frame.width) * size.width).toBeCloseTo(24)
    expect((bounds.y / frame.height) * size.height).toBeCloseTo((size.height - contentHeight) / 2)
    expect((bounds.width / frame.width) * size.width).toBeCloseTo(size.width - 48)
    expect((bounds.height / frame.height) * size.height).toBeCloseTo(contentHeight)
    expect(encode).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.94)
    expect(close).toHaveBeenCalledTimes(1)
    expect([frame.canvas.width, frame.canvas.height]).toEqual([0, 0])
  })

  it('finishes embedding and releases page pixels before rendering the next page', async () => {
    const { frames, close } = mockA4Composition()
    const images: PDFImage[] = []
    const embedPng = PDFDocument.prototype.embedPng
    vi.spyOn(PDFDocument.prototype, 'embedPng').mockImplementation(async function (
      this: PDFDocument,
      data,
    ) {
      const image = await embedPng.call(this, data)
      images.push(image)
      return image
    })
    const expectReleased = (pageCount: number) => {
      expect(images).toHaveLength(pageCount)
      expect(close).toHaveBeenCalledTimes(pageCount)
      for (const image of images) {
        // PDFImage.embed() drops the PNG decoder and its RGB/alpha buffers.
        expect(image).toHaveProperty('embedder', undefined)
        expect(image.doc.context.lookup(image.ref)).toBeDefined()
      }
      for (const frame of frames) expect([frame.canvas.width, frame.canvas.height]).toEqual([0, 0])
    }
    renderMock.mockReset()
    let renderedCount = 0
    renderMock.mockImplementation(async () => {
      expectReleased(renderedCount)
      renderedCount += 1
      return { blob: new Blob([png], { type: 'image/png' }), width: 1200, height: 750 }
    })
    const save = PDFDocument.prototype.save
    vi.spyOn(PDFDocument.prototype, 'save').mockImplementation(function (
      this: PDFDocument,
      options,
    ) {
      expectReleased(2)
      return save.call(this, options)
    })
    const result = await exportProject(
      makeProject({ watermark }),
      [makePage(), makePage({ id: 'page-2', order: 1 })],
      'pdf',
      'a4',
    )
    const pdf = await PDFDocument.load(await result.blob.arrayBuffer())
    expect(pdf.getPageCount()).toBe(2)
  })
})
