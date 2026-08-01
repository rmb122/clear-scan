import path from 'node:path'
import { expect, test } from '@playwright/test'

test('home page exposes all three scan modes', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /清晰扫描仪/ })).toBeVisible()
  await expect(page.getByText('身份证扫描', { exact: true })).toBeVisible()
  await expect(page.getByText('护照扫描', { exact: true })).toBeVisible()
  await expect(page.getByText('文档扫描', { exact: true })).toBeVisible()
})

test('local OpenCV asset initializes inside a classic worker', async ({ page }) => {
  await page.goto('/')
  const state = await page.evaluate(() => new Promise<Record<string, unknown>>((resolve, reject) => {
    const opencvUrl = new URL('/vendor/opencv.js', window.location.origin).href
    const source = `
      importScripts(${JSON.stringify(opencvUrl)});
      postMessage({ phase: 'loaded', cvType: typeof cv, promise: cv instanceof Promise, info: typeof cv?.getBuildInformation, calledRun: cv?.calledRun });
      if (cv instanceof Promise) cv.then(() => postMessage({ phase: 'ready' }));
      else if (typeof cv.getBuildInformation === 'function') postMessage({ phase: 'ready' });
      else cv.onRuntimeInitialized = () => postMessage({ phase: 'ready' });
    `
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const worker = new Worker(url)
    const timer = window.setTimeout(() => reject(new Error('OpenCV worker initialization timed out')), 30_000)
    let loaded: Record<string, unknown> = {}
    worker.onmessage = (event) => {
      if (event.data.phase === 'loaded') loaded = event.data
      if (event.data.phase === 'ready') {
        window.clearTimeout(timer)
        worker.terminate()
        URL.revokeObjectURL(url)
        resolve(loaded)
      }
    }
    worker.onerror = (event) => reject(new Error(event.message))
  }))
  expect(state.cvType).toBe('object')
})

test('uploads a document and reaches the crop editor', async ({ page }) => {
  await page.goto('/scan/document')
  await expect(page.getByRole('heading', { name: '添加文档页面' })).toBeVisible()
  const upload = page.locator('input[type="file"]').nth(1)
  await upload.setInputFiles(path.resolve('e2e/fixtures/document.png'))
  await expect(page.getByText('确认四个角点')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('已自动找到边缘')).toBeVisible()
  await expect(page.getByText('确认文档边缘', { exact: true })).toHaveCount(0)
  const storageShape = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('clear-scan-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction('pages').objectStore('pages').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    const source = (records[0] as { source?: unknown } | undefined)?.source
    return {
      isBlob: source instanceof Blob,
      hasArrayBuffer: Boolean(source && typeof source === 'object' && 'data' in source && (source as { data: unknown }).data instanceof ArrayBuffer),
    }
  })
  expect(storageShape).toEqual({ isBlob: false, hasArrayBuffer: true })
  await page.getByRole('button', { name: '确认裁剪' }).click()
  await expect(page.getByText('调整扫描效果')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('img', { name: '扫描增强预览' })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('button', { name: '去反光', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存页面' }).click()
  await page.getByRole('button', { name: '导出' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '生成并下载' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.pdf$/)
})

test('ID card and passport modes expose their specialized capture flows', async ({ page }) => {
  await page.goto('/scan/id-card')
  await expect(page.getByRole('heading', { name: '拍摄身份证人像面' })).toBeVisible()

  await page.goto('/scan/passport')
  await expect(page.getByRole('heading', { name: '拍摄护照资料页' })).toBeVisible()
  await expect(page.getByRole('button', { name: '资料页单页' })).toBeVisible()
  await expect(page.getByRole('button', { name: '展开双页' })).toBeVisible()
})

test('mobile bottom navigation keeps a compact fixed height', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Only applies to the mobile shell')
  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: '移动端主导航' })
  await expect(navigation).toBeVisible()
  const box = await navigation.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(box!.height).toBeLessThanOrEqual(65)
  expect(Math.abs(box!.y + box!.height - viewport!.height)).toBeLessThanOrEqual(1)
})
