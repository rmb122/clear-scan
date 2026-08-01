import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

async function waitForPreviewChange(page: Page, previous?: string | null) {
  const image = page.getByRole('img', { name: '扫描增强预览' })
  await expect(image).toBeVisible({ timeout: 120_000 })
  if (previous) await expect.poll(() => image.getAttribute('src')).not.toBe(previous)
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
  return image.getAttribute('src')
}

async function previewRegions(page: Page) {
  return page.getByRole('img', { name: '扫描增强预览' }).evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const mean = (x0: number, x1: number, y0: number, y1: number) => {
      let sum = 0
      let count = 0
      for (let y = Math.floor(canvas.height * y0); y < canvas.height * y1; y += 3) {
        for (let x = Math.floor(canvas.width * x0); x < canvas.width * x1; x += 3) {
          const offset = (Math.floor(y) * canvas.width + Math.floor(x)) * 4
          sum += pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
          count += 1
        }
      }
      return sum / count
    }
    return {
      shadowPaper: mean(0.1, 0.24, 0.12, 0.22),
      lightPaper: mean(0.76, 0.9, 0.12, 0.22),
      shadowInk: mean(0.1, 0.24, 0.42, 0.46),
      shadowAroundInk: mean(0.1, 0.24, 0.36, 0.4),
    }
  })
}

async function createShadowFixture(page: Page) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 1000
    const context = canvas.getContext('2d')!
    context.fillStyle = '#f8f5eb'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const shadow = context.createLinearGradient(0, 0, 500, 0)
    shadow.addColorStop(0, 'rgba(31,43,53,.52)')
    shadow.addColorStop(0.72, 'rgba(31,43,53,.18)')
    shadow.addColorStop(1, 'rgba(31,43,53,0)')
    context.fillStyle = shadow
    context.fillRect(0, 0, 520, canvas.height)
    context.fillStyle = '#1f2937'
    for (let row = 0; row < 7; row += 1) {
      context.fillRect(80, 360 + row * 72, 610 - row * 18, 28)
    }
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  return Buffer.from(bytes)
}

test('standard shadow removal flattens cast shadows while retaining ink contrast', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'One image-engine run is enough')
  await page.goto('/scan/document')
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: 'synthetic-shadow.png',
    mimeType: 'image/png',
    buffer: await createShadowFixture(page),
  })
  await expect(page.getByText('确认四个角点')).toBeVisible({ timeout: 120_000 })
  await page.getByRole('button', { name: '确认裁剪' }).click()
  await waitForPreviewChange(page)
  await page.getByRole('button', { name: '原版', exact: true }).click()
  const originalSrc = await waitForPreviewChange(page)
  const original = await previewRegions(page)
  await page.getByRole('button', { name: '去阴影', exact: true }).click()
  await waitForPreviewChange(page, originalSrc)
  const corrected = await previewRegions(page)

  const originalVariation = Math.abs(original.lightPaper - original.shadowPaper)
  const correctedVariation = Math.abs(corrected.lightPaper - corrected.shadowPaper)
  expect(correctedVariation).toBeLessThan(originalVariation * 0.55)
  const originalInkContrast = original.shadowAroundInk - original.shadowInk
  const correctedInkContrast = corrected.shadowAroundInk - corrected.shadowInk
  expect(correctedInkContrast).toBeGreaterThan(originalInkContrast * 0.85)
})

test('installs the FP16 model, saves a correction map, then exports after uninstall', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'The 59 MiB model smoke test runs once')
  test.setTimeout(300_000)
  await page.goto('/settings')
  await page.getByRole('button', { name: '安装高级模型' }).click()
  await expect(page.getByText('已安装', { exact: true })).toBeVisible({ timeout: 240_000 })
  const modelState = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('clear-scan-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction(['models', 'modelChunks'])
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = transaction.objectStore('models').get('docshadow-sd7k-fp16')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const chunks = await new Promise<Array<{ data: ArrayBuffer }>>((resolve, reject) => {
      const request = transaction.objectStore('modelChunks').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return {
      state: record.state,
      benchmarkMs: record.benchmarkMs,
      inputSize: record.inputSize,
      bytes: chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0),
    }
  })
  expect(modelState.state).toBe('ready')
  expect(Number(modelState.benchmarkMs)).toBeGreaterThan(0)
  expect([256, 384, 512]).toContain(modelState.inputSize)
  expect(modelState.bytes).toBe(62_045_318)

  await page.goto('/scan/document')
  await page.locator('input[type="file"]').nth(1).setInputFiles(path.resolve('e2e/fixtures/document.png'))
  await expect(page.getByText('确认四个角点')).toBeVisible({ timeout: 120_000 })
  await page.getByRole('button', { name: '确认裁剪' }).click()
  await waitForPreviewChange(page)
  await page.getByRole('button', { name: 'AI 去阴影', exact: true }).click()
  await expect.poll(async () => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('clear-scan-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const records = await new Promise<Array<{ advancedCorrection?: { map?: { data?: ArrayBuffer } } }>>((resolve, reject) => {
      const request = database.transaction('pages').objectStore('pages').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return records.some((record) => (record.advancedCorrection?.map?.data?.byteLength ?? 0) > 0)
  }), { timeout: 180_000 }).toBe(true)
  await page.getByRole('button', { name: '保存页面' }).click()
  const projectUrl = page.url()

  await page.goto('/settings')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '卸载模型' }).click()
  await expect(page.getByRole('button', { name: '安装高级模型' })).toBeVisible()
  await page.goto(projectUrl)
  await waitForPreviewChange(page)
  await page.getByRole('button', { name: '导出' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '生成并下载' }).click()
  await expect((await download).suggestedFilename()).toMatch(/\.pdf$/)
})

test('settings are reachable without changing the three-column mobile toolbar', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile shell only')
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: '本地图像引擎' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '移动端主导航' })).toBeVisible()
  await expect(page.getByRole('link', { name: '本地图像引擎设置' })).toBeVisible()
})
