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
  const state = await page.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
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
      }),
  )
  expect(state.cvType).toBe('object')
})

test('uploads a document and reaches the crop editor', async ({ page }) => {
  await page.goto('/scan/document')
  await expect(page.getByRole('heading', { name: '添加文档页面' })).toBeVisible()
  const upload = page.locator('input[type="file"]').nth(1)
  await upload.setInputFiles(path.resolve('e2e/fixtures/document.png'))
  await expect(page.getByText('确认四个角点')).toBeVisible({
    timeout: 120_000,
  })
  await expect(page.getByText('已预识别边缘，请人工确认')).toBeVisible()
  await expect(page.getByText('预识别结果待确认')).toBeVisible()
  await expect(page.getByText('自动识别完成')).toHaveCount(0)
  await expect(page.getByText('确认文档边缘', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '导出' })).toBeDisabled()
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
    const record = records[0] as { source?: unknown; thumbnail?: unknown } | undefined
    const source = record?.source
    return {
      isBlob: source instanceof Blob,
      hasPrematureThumbnail: Boolean(record?.thumbnail),
      hasArrayBuffer: Boolean(
        source &&
          typeof source === 'object' &&
          'data' in source &&
          (source as { data: unknown }).data instanceof ArrayBuffer,
      ),
    }
  })
  expect(storageShape).toEqual({ isBlob: false, hasPrematureThumbnail: false, hasArrayBuffer: true })
  const pageThumbnail = page.getByRole('button', { name: '打开第 1 页' }).locator('img')
  await expect
    .poll(() => pageThumbnail.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]))
    .toEqual([1200, 900])
  await page.getByRole('button', { name: '确认裁剪' }).click()
  await expect(page.getByRole('button', { name: '导出' })).toBeEnabled()
  await expect(page.getByText('调整扫描效果')).toBeVisible({
    timeout: 120_000,
  })
  const workspace = page.locator('section.paper-grid')
  const loading = page.getByRole('status')
  await expect(loading).toBeVisible()
  const [workspaceBox, loadingContentBox] = await Promise.all([
    workspace.boundingBox(),
    loading.locator(':scope > div').boundingBox(),
  ])
  expect(workspaceBox).not.toBeNull()
  expect(loadingContentBox).not.toBeNull()
  expect(
    Math.abs(loadingContentBox!.x + loadingContentBox!.width / 2 - (workspaceBox!.x + workspaceBox!.width / 2)),
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(loadingContentBox!.y + loadingContentBox!.height / 2 - (workspaceBox!.y + workspaceBox!.height / 2)),
  ).toBeLessThanOrEqual(1)
  await expect(page.getByRole('img', { name: '扫描增强预览' })).toBeVisible({
    timeout: 120_000,
  })
  await expect(page.getByText(/检测到(?:轻微反光|明显过曝区域)/)).toHaveCount(0)
  const shadow = page.getByRole('button', { name: '标准去阴影', exact: true })
  const glare = page.getByRole('button', { name: '去反光', exact: true })
  const sharpen = page.getByRole('button', { name: '加锐', exact: true })
  const enhancedColor = page.getByRole('button', {
    name: '彩色增强',
    exact: true,
  })
  const blackWhite = page.getByRole('button', { name: '黑白', exact: true })
  await expect(shadow).toHaveAttribute('aria-pressed', 'true')
  await expect(glare).toHaveAttribute('aria-pressed', 'true')
  await expect(enhancedColor).toHaveAttribute('aria-pressed', 'true')
  await expect(sharpen).toHaveAttribute('aria-pressed', 'true')
  await blackWhite.click()
  await expect(blackWhite).toHaveAttribute('aria-pressed', 'true')
  await expect(enhancedColor).toHaveAttribute('aria-pressed', 'false')
  await expect(shadow).toHaveAttribute('aria-pressed', 'true')
  await expect(glare).toHaveAttribute('aria-pressed', 'true')
  await expect(sharpen).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '保存页面' }).click()
  await page.getByRole('button', { name: '导出' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '生成并下载' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.pdf$/)
})

test('scan history can clear all local projects', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'One storage cleanup run is enough')
  await page.goto('/scan/document')
  await page.locator('input[type="file"]').nth(1).setInputFiles(path.resolve('e2e/fixtures/document.png'))
  await expect(page.getByText('确认四个角点')).toBeVisible({
    timeout: 120_000,
  })

  await page.goto('/history')
  const clearButton = page.getByRole('button', { name: '清空所有历史数据' })
  await expect(clearButton).toBeEnabled()
  await clearButton.click()
  await expect(page.getByRole('heading', { name: '清空所有扫描历史？' })).toBeVisible()
  await page.getByRole('button', { name: '确认清空' }).click()
  await expect(page.getByText('所有扫描历史已清空')).toBeVisible()
  const counts = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('clear-scan-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction(['projects', 'pages'])
    const count = (store: 'projects' | 'pages') =>
      new Promise<number>((resolve, reject) => {
        const request = transaction.objectStore(store).count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const [projects, pages] = await Promise.all([count('projects'), count('pages')])
    const result = { projects, pages }
    database.close()
    return result
  })
  expect(counts).toEqual({ projects: 0, pages: 0 })
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
