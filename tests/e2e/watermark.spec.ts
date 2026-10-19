import { readFile } from 'node:fs/promises'
import { expect, test, type Locator } from '@playwright/test'

async function previewPixels(image: Locator) {
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
    )
    .toBe(true)
  return image.evaluate(async (element: HTMLImageElement) => {
    // Snapshot the displayed bitmap before an update can revoke its object URL.
    const canvas = document.createElement('canvas')
    canvas.width = element.naturalWidth
    canvas.height = element.naturalHeight
    canvas.getContext('2d')!.drawImage(element, 0, 0)
    const helperPath = '/tests/support/watermark.ts'
    const { watermarkPixels } = await import(helperPath)
    return watermarkPixels(canvas)
  })
}

test('watermark dialog previews, saves, exports, and disables Chinese text', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const dbPath = '/src/lib/db.ts'
    const fixturePath = '/tests/support/scan-fixtures.ts'
    const helperPath = '/tests/support/watermark.ts'
    const { db, putPage } = await import(dbPath)
    const { makeProject } = await import(fixturePath)
    const { makeWatermarkPage } = await import(helperPath)
    await db.projects.put(makeProject())
    await putPage(await makeWatermarkPage())
  })
  await page.goto('/#/project/project-1')
  const editorPreview = page.getByRole('img', { name: '扫描增强预览' })
  await expect(page.getByRole('button', { name: '保存页面', exact: true })).toBeEnabled({
    timeout: 120_000,
  })
  const baseline = await previewPixels(editorPreview)
  expect(baseline.red).toBe(0)

  const button = page.getByRole('button', { name: '水印', exact: true })
  const exportButton = page.getByRole('button', { name: '导出', exact: true })
  if (testInfo.project.name === 'mobile-chromium') {
    await page.setViewportSize({ width: 320, height: 568 })
  }
  const [watermarkBox, exportBox] = await Promise.all([
    button.boundingBox(),
    exportButton.boundingBox(),
  ])
  expect(watermarkBox!.x + watermarkBox!.width).toBeLessThanOrEqual(exportBox!.x)
  expect(watermarkBox!.y).toBeCloseTo(exportBox!.y)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1)
  const previewUrl = await editorPreview.getAttribute('src')
  await button.click()
  const dialog = page.getByRole('dialog', { name: '水印设置' })
  const preview = dialog.getByRole('img', { name: '水印效果预览' })
  await expect(preview).toHaveAttribute('src', previewUrl!)
  await dialog.getByRole('switch', { name: '启用水印' }).click()
  await dialog.getByRole('textbox', { name: '水印文字' }).fill('仅供审核使用')
  await dialog.getByLabel('水印颜色').evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '#ff0000',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await dialog.getByRole('slider', { name: '不透明度' }).focus()
  await dialog.getByRole('slider', { name: '不透明度' }).press('End')
  await expect(dialog.getByRole('slider', { name: '不透明度' })).toHaveAttribute(
    'aria-valuenow',
    '100',
  )
  await expect.poll(async () => (await previewPixels(preview)).red).toBeGreaterThan(1000)
  const marked = await previewPixels(preview)
  expect([marked.width, marked.height]).toEqual([baseline.width, baseline.height])
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')

  await exportButton.click()
  await page.getByRole('button', { name: /PNG 图片/ }).click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '生成并下载' }).click()
  const download = await downloading
  const bytes = await readFile((await download.path())!)
  const exported = await page.evaluate(async (data) => {
    const helperPath = '/tests/support/watermark.ts'
    const { watermarkBlobPixels } = await import(helperPath)
    return watermarkBlobPixels(new Blob([new Uint8Array(data)], { type: 'image/png' }))
  }, Array.from(bytes))
  expect(exported.red).toBeGreaterThan(1000)
  expect([exported.width, exported.height]).toEqual([baseline.width, baseline.height])

  await page.reload()
  await button.click()
  await expect(dialog.getByRole('textbox', { name: '水印文字' })).toHaveValue('仅供审核使用')
  await expect(dialog.getByRole('slider', { name: '不透明度' })).toHaveAttribute(
    'aria-valuenow',
    '100',
  )
  await expect.poll(async () => (await previewPixels(preview)).red).toBeGreaterThan(1000)
  await dialog.getByRole('switch', { name: '启用水印' }).click()
  await expect.poll(async () => (await previewPixels(preview)).red).toBe(0)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: '切换为英语' }).click()
  await page.getByRole('button', { name: 'Watermark', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Watermark settings' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Watermark text' })).toHaveValue('仅供审核使用')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('tiled text scales with the content and stays within the expanded bounds', async ({
  page,
}) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const watermarkPath = '/src/lib/watermark.ts'
    const typesPath = '/src/lib/types.ts'
    const helperPath = '/tests/support/watermark.ts'
    const { drawWatermark } = await import(watermarkPath)
    const { DEFAULT_WATERMARK } = await import(typesPath)
    const { watermarkPixels } = await import(helperPath)
    const settings = {
      ...DEFAULT_WATERMARK,
      enabled: true,
      text: '仅供审核使用',
      color: '#ff0000',
      opacity: 50,
    }
    const content = { x: 150, y: 250, width: 500, height: 300 }
    const render = (scale: number) => {
      const canvas = document.createElement('canvas')
      canvas.width = 800 * scale
      canvas.height = 1000 * scale
      drawWatermark(
        canvas.getContext('2d')!,
        {
          x: content.x * scale,
          y: content.y * scale,
          width: content.width * scale,
          height: content.height * scale,
        },
        settings,
      )
      return canvas
    }
    const original = render(1)
    const large = render(2)
    const normalized = document.createElement('canvas')
    normalized.width = original.width
    normalized.height = original.height
    normalized.getContext('2d')!.drawImage(large, 0, 0, normalized.width, normalized.height)
    const first = original
      .getContext('2d')!
      .getImageData(0, 0, original.width, original.height).data
    const second = normalized
      .getContext('2d')!
      .getImageData(0, 0, normalized.width, normalized.height).data
    let alphaDifference = 0
    for (let index = 3; index < first.length; index += 4)
      alphaDifference += Math.abs(first[index] - second[index])
    return {
      pixels: watermarkPixels(original, [content]),
      alphaDifference: alphaDifference / (original.width * original.height),
    }
  })
  expect(result.pixels.red).toBeGreaterThan(1000)
  expect(result.pixels.outsideContent).toBeGreaterThan(0)
  expect(result.pixels.outsideExpansion).toBe(0)
  expect(result.pixels.maxAlpha).toBeGreaterThanOrEqual(127)
  expect(result.pixels.maxAlpha).toBeLessThanOrEqual(128)
  expect(result.alphaDifference).toBeLessThan(1)
})

test('A4 PDFs contain only watermarked scans with marked whitespace and ZIP marks every page', async ({
  page,
}) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const exporterPath = '/src/lib/exporters.ts'
    const typesPath = '/src/lib/types.ts'
    const layoutPath = '/src/lib/id-card-layout.ts'
    const fixturePath = '/tests/support/scan-fixtures.ts'
    const helperPath = '/tests/support/watermark.ts'
    const { exportProject } = await import(exporterPath)
    const { DEFAULT_WATERMARK } = await import(typesPath)
    const { getIdCardSheetLayout } = await import(layoutPath)
    const { makeProject } = await import(fixturePath)
    const { makeWatermarkPage, watermarkPdfImages, watermarkBlobPixels, watermarkZipPixels } =
      await import(helperPath)
    const watermark = {
      ...DEFAULT_WATERMARK,
      enabled: true,
      text: '仅供审核使用',
      color: '#ff0000',
      opacity: 100,
    }
    const front = await makeWatermarkPage({ role: 'front' })
    const back = { ...front, id: 'page-2', role: 'back', order: 1 }
    const idImage = await exportProject(
      makeProject({ mode: 'id-card', watermark }),
      [front, back],
      'png',
      'a4',
    )
    const cards = getIdCardSheetLayout(2480, 3508, 'original')
    const idPixels = await watermarkBlobPixels(idImage.blob, [cards.front, cards.back])

    const pdf = await exportProject(makeProject({ watermark }), [front, back], 'pdf', 'a4')
    const widthPoints = (210 / 25.4) * 72
    const heightPoints = (297 / 25.4) * 72
    const width = widthPoints - 48
    const height = (width * front.height) / front.width
    const pdfImages = await watermarkPdfImages(pdf.blob, [
      {
        x: (24 / widthPoints) * 2480,
        y: ((heightPoints - height) / 2 / heightPoints) * 3508,
        width: (width / widthPoints) * 2480,
        height: (height / heightPoints) * 3508,
      },
    ])
    const zip = await exportProject(makeProject({ watermark }), [front, back], 'zip', 'content')
    const zipPixels = await watermarkZipPixels(zip.blob)
    return { idPixels, pdfImages, pdfType: pdf.blob.type, pdfSize: pdf.blob.size, zipPixels }
  })
  expect(result.pdfImages.pages).toHaveLength(2)
  expect(result.pdfImages.images).toHaveLength(2)
  for (const image of result.pdfImages.images) {
    expect(image.filter).toBe('/DCTDecode')
    expect(image.hasMask).toBe(false)
    expect(image.pixels.neutralDark).toBeGreaterThan(1000)
    expect(image.pixels.red - image.pixels.outsideContent).toBeGreaterThan(1000)
  }
  for (const pixels of [
    result.idPixels,
    ...result.pdfImages.images.map((image: { pixels: typeof result.idPixels }) => image.pixels),
  ]) {
    expect(pixels.red).toBeGreaterThan(1000)
    expect(pixels.outsideContent).toBeGreaterThan(0)
    expect(pixels.outsideExpansion).toBe(0)
  }
  expect(result.pdfType).toBe('application/pdf')
  expect(result.pdfSize).toBeGreaterThan(1000)
  expect(result.zipPixels).toHaveLength(2)
  for (const pixels of result.zipPixels) expect(pixels.red).toBeGreaterThan(1000)
})
