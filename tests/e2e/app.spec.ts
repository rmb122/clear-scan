import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { waitForScannerReady } from './helpers'

test('home page loads synchronously without a route loading overlay', async ({ page }) => {
  let releaseHomePage!: () => void
  const homePageGate = new Promise<void>((resolve) => {
    releaseHomePage = resolve
  })
  await page.route(/\/src\/pages\/home-page\.tsx(?:\?|$)/, async (route) => {
    await homePageGate
    await route.continue()
  })

  const navigation = page.goto('/')
  await page.waitForTimeout(300)
  await expect(page.getByText('正在打开页面', { exact: true })).toBeHidden()

  releaseHomePage()
  await navigation
  await expect(page.getByRole('heading', { name: /清晰扫描仪/ })).toBeVisible()
  await expect(page.getByText('身份证扫描', { exact: true })).toBeVisible()
  await expect(page.getByText('护照扫描', { exact: true })).toBeVisible()
  await expect(page.getByText('文档扫描', { exact: true })).toBeVisible()
})

test('cached lazy pages do not flash a route loading overlay', async ({ page }) => {
  await page.goto('/#/history')
  await expect(page.getByRole('heading', { name: '扫描记录', exact: true })).toBeVisible()

  await page.addInitScript(() => {
    const state = window as typeof window & { routeLoadingOverlaySeen?: boolean }
    state.routeLoadingOverlaySeen = false
    const recordOverlay = () => {
      if (
        [...document.querySelectorAll('[role="status"]')].some((element) =>
          element.textContent?.includes('正在打开页面'),
        )
      ) {
        state.routeLoadingOverlaySeen = true
      }
    }
    new MutationObserver(recordOverlay).observe(document, { childList: true, subtree: true })
  })

  await page.goto('/')
  await page.locator('a[href="#/history"]:visible').click()
  await expect(page.getByRole('heading', { name: '扫描记录', exact: true })).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { routeLoadingOverlaySeen?: boolean }).routeLoadingOverlaySeen,
    ),
  ).toBe(false)
})

test('shows immediate feedback while the scan page bundle is still loading', async ({ page }) => {
  let releaseScanPage!: () => void
  const scanPageGate = new Promise<void>((resolve) => {
    releaseScanPage = resolve
  })
  await page.route(/\/src\/pages\/scan-page\.tsx(?:\?|$)/, async (route) => {
    await scanPageGate
    await route.continue()
  })

  await page.goto('/')
  await page.getByRole('button', { name: '开始扫描' }).click()

  await expect(page).toHaveURL(/#\/scan\/document$/)
  await expect(page.getByRole('status').getByText('正在打开扫描页面')).toBeVisible()

  releaseScanPage()
  await expect(page.getByText('首次加载图像引擎')).toBeVisible()
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
        const timer = window.setTimeout(
          () => reject(new Error('OpenCV worker initialization timed out')),
          30_000,
        )
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

test('shows progress while the image engine loads for the first time', async ({ page }) => {
  let releaseOpenCv!: () => void
  const openCvGate = new Promise<void>((resolve) => {
    releaseOpenCv = resolve
  })
  await page.route('**/vendor/opencv.js', async (route) => {
    await openCvGate
    await route.continue()
  })

  await page.goto('/#/scan/document')
  await expect(page.getByText('首次加载图像引擎')).toBeVisible()
  await expect(page.getByText('正在下载图像引擎（约 11 MB），可能需要一些时间')).toBeVisible()
  await expect(page.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  await expect(page.getByRole('button', { name: '从相册或电脑上传' })).toBeDisabled()

  releaseOpenCv()
  await expect(page.getByText('首次加载图像引擎')).toBeHidden({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: '从相册或电脑上传' })).toBeEnabled()
})

test('reuses the cached image engine without showing a reload overlay', async ({ page }) => {
  let openCvRequests = 0
  await page.route('**/vendor/opencv.js', async (route) => {
    openCvRequests += 1
    await route.continue()
  })

  await page.goto('/#/scan/document')
  await waitForScannerReady(page)
  expect(openCvRequests).toBe(1)

  await page.reload()
  await page.waitForTimeout(800)
  await expect(page.getByText('正在打开扫描页面')).toBeHidden()
  await expect(page.getByText('首次加载图像引擎')).toBeHidden()
  await waitForScannerReady(page)
  await expect(page.getByText('首次加载图像引擎')).toBeHidden()
  expect(openCvRequests).toBe(1)

  await page.getByRole('link', { name: '清晰扫描首页' }).click()
  await page.getByRole('button', { name: '开始扫描' }).click()
  await expect(page).toHaveURL(/#\/scan\/document$/)
  await expect(page.getByText('正在打开扫描页面')).toBeHidden()
  await expect(page.getByText('首次加载图像引擎')).toBeHidden()
})

test('allows retrying after the image engine fails to load', async ({ page }) => {
  let failOpenCvRequest = true
  await page.route('**/vendor/opencv.js', async (route) => {
    if (failOpenCvRequest) await route.abort('failed')
    else await route.continue()
  })

  await page.goto('/#/scan/document')
  await expect(page.getByText('图像引擎加载失败')).toBeVisible()
  await expect(page.getByText(/请检查网络后重试/)).toBeVisible()

  failOpenCvRequest = false
  await page.getByRole('button', { name: '重新加载' }).click()

  await expect(page.getByText('首次加载图像引擎')).toBeHidden({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: '从相册或电脑上传' })).toBeEnabled()
  await expect(page.getByText('图像引擎加载失败')).toBeHidden()
})

test('upload recovers a failed image engine and clears its stale error', async ({ page }) => {
  let failOpenCvRequest = true
  await page.route('**/vendor/opencv.js', async (route) => {
    if (failOpenCvRequest) await route.abort('failed')
    else await route.continue()
  })
  await page.goto('/#/scan/document')
  await expect(page.getByRole('alert')).toContainText('图像引擎加载失败')

  failOpenCvRequest = false
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles(path.resolve('tests/e2e/fixtures/document.png'))

  await expect(page.getByText('确认四个角点')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('alert')).toBeHidden()
  await expect(page.getByRole('button', { name: '确认裁剪' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '重新识别' })).toBeEnabled()
})

test('uploads a document and reaches the crop editor', async ({ page }, testInfo) => {
  await page.goto('/#/scan/document')
  await expect(page.getByRole('heading', { name: '添加文档页面' })).toBeVisible()
  await waitForScannerReady(page)
  const upload = page.locator('input[type="file"]').nth(1)
  await upload.setInputFiles(path.resolve('tests/e2e/fixtures/document.png'))
  await expect(page.getByText('确认四个角点')).toBeVisible({
    timeout: 120_000,
  })
  await expect(page.getByText('已预识别边缘，请人工确认')).toBeVisible()
  await expect(page.getByText('预识别结果待确认')).toBeVisible()
  await expect(page.getByText('自动识别完成')).toHaveCount(0)
  await expect(page.getByText('确认文档边缘', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '导出' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '第 1 页前移' })).toBeVisible()
  await expect(page.getByRole('button', { name: '第 1 页前移' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '第 1 页后移' })).toBeVisible()
  await expect(page.getByRole('button', { name: '第 1 页后移' })).toBeDisabled()
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
  expect(storageShape).toEqual({
    isBlob: false,
    hasPrematureThumbnail: false,
    hasArrayBuffer: true,
  })
  const pageThumbnail = page.getByRole('button', { name: '打开第 1 页' }).locator('img')
  await expect
    .poll(() =>
      pageThumbnail.evaluate((image: HTMLImageElement) => [
        image.naturalWidth,
        image.naturalHeight,
      ]),
    )
    .toEqual([1200, 900])
  await page.getByRole('button', { name: '确认裁剪' }).click()
  await expect(page.getByRole('button', { name: '导出' })).toBeEnabled()
  await expect(page.getByText('调整扫描效果')).toBeVisible({
    timeout: 120_000,
  })
  const loading = page.getByRole('status')
  await expect(loading).toBeVisible()
  await expect
    .poll(() =>
      loading.evaluate((element) => {
        const workspaceElement = element.closest('section')
        const content = element.firstElementChild
        if (!workspaceElement || !content) return Number.POSITIVE_INFINITY
        const workspaceBox = workspaceElement.getBoundingClientRect()
        const contentBox = content.getBoundingClientRect()
        const horizontalOffset = Math.abs(
          contentBox.x + contentBox.width / 2 - (workspaceBox.x + workspaceBox.width / 2),
        )
        const verticalOffset = Math.abs(
          contentBox.y + contentBox.height / 2 - (workspaceBox.y + workspaceBox.height / 2),
        )
        return Math.max(horizontalOffset, verticalOffset)
      }),
    )
    .toBeLessThanOrEqual(1)
  await expect(page.getByRole('img', { name: '扫描增强预览' })).toBeVisible({
    timeout: 120_000,
  })
  await expect(page.getByText(/检测到(?:轻微反光|明显过曝区域)/)).toHaveCount(0)
  const shadow = page.getByRole('button', { name: '标准去阴影', exact: true })
  const balance = page.getByRole('button', { name: '亮度均衡', exact: true })
  const glare = page.getByRole('button', { name: '去反光', exact: true })
  const sharpen = page.getByRole('button', { name: '加锐', exact: true })
  const enhancedColor = page.getByRole('button', {
    name: '彩色增强',
    exact: true,
  })
  const blackWhite = page.getByRole('button', { name: '黑白', exact: true })
  const originalPreset = page.getByRole('button', { name: '原版', exact: true })
  const smartPreset = page.getByRole('button', { name: '智能增强', exact: true })
  const lightGroup = page.getByRole('group', { name: '光照修复' })
  const lightOff = lightGroup.getByRole('button', { name: '关闭', exact: true })
  const [originalBox, smartBox, lightOffBox, shadowBox, balanceBox] = await Promise.all([
    originalPreset.boundingBox(),
    smartPreset.boundingBox(),
    lightOff.boundingBox(),
    shadow.boundingBox(),
    balance.boundingBox(),
  ])
  expect(originalBox).not.toBeNull()
  expect(smartBox).not.toBeNull()
  expect(lightOffBox).not.toBeNull()
  expect(shadowBox).not.toBeNull()
  expect(balanceBox).not.toBeNull()
  expect(Math.abs(smartBox!.y - originalBox!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(smartBox!.width - originalBox!.width)).toBeLessThanOrEqual(1)
  expect(originalBox!.x + originalBox!.width).toBeLessThanOrEqual(smartBox!.x)
  expect(lightOffBox!.width).toBeGreaterThan(shadowBox!.width * 1.8)
  expect(Math.abs(shadowBox!.y - balanceBox!.y)).toBeLessThanOrEqual(1)
  expect(shadowBox!.x + shadowBox!.width).toBeLessThanOrEqual(balanceBox!.x)
  await expect(balance).toHaveAttribute('aria-pressed', 'true')
  await expect(shadow).toHaveAttribute('aria-pressed', 'false')
  await expect(glare).toHaveAttribute('aria-pressed', 'true')
  await expect(enhancedColor).toHaveAttribute('aria-pressed', 'true')
  await expect(sharpen).toHaveAttribute('aria-pressed', 'true')
  await blackWhite.click()
  await expect(blackWhite).toHaveAttribute('aria-pressed', 'true')
  await expect(enhancedColor).toHaveAttribute('aria-pressed', 'false')
  await expect(balance).toHaveAttribute('aria-pressed', 'true')
  await expect(glare).toHaveAttribute('aria-pressed', 'true')
  await expect(sharpen).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '保存页面' }).click()
  await page.getByRole('button', { name: '导出' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '生成并下载' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.pdf$/)

  if (testInfo.project.name === 'desktop-chromium') {
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: '删除第 1 页' }).click()
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(page.getByRole('heading', { name: '添加文档页面' })).toBeVisible()
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    )
    expect(pageOverflow).toBe(0)
  }
})

test('shows progress while document edges are re-detected', async ({ page }) => {
  await page.goto('/#/scan/document')
  await waitForScannerReady(page)
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles(path.resolve('tests/e2e/fixtures/document.png'))
  await expect(page.getByText('确认四个角点')).toBeVisible({ timeout: 120_000 })

  const confirmCrop = page.getByRole('button', { name: '确认裁剪' })
  await page.getByRole('button', { name: '重新识别' }).click()

  await expect(page.getByText('正在重新识别边缘')).toBeVisible()
  await expect(confirmCrop).toBeDisabled()
  await expect(page.getByText('已重新识别边缘')).toBeVisible({ timeout: 30_000 })
  await expect(confirmCrop).toBeEnabled()
})

test('scan history can clear all local projects', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'One storage cleanup run is enough')
  await page.goto('/#/scan/document')
  await waitForScannerReady(page)
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles(path.resolve('tests/e2e/fixtures/document.png'))
  await expect(page.getByText('确认四个角点')).toBeVisible({
    timeout: 120_000,
  })

  await page.goto('/#/history')
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
  await page.goto('/#/scan/id-card')
  await expect(page.getByRole('heading', { name: '拍摄身份证人像面' })).toBeVisible()

  await page.goto('/#/scan/passport')
  await expect(page.getByRole('heading', { name: '拍摄护照资料页' })).toBeVisible()
  await expect(page.getByRole('button', { name: '资料页单页' })).toBeVisible()
  await expect(page.getByRole('button', { name: '展开双页' })).toBeVisible()
})

test('ID card export defaults to actual size and keeps the selection across formats', async ({
  page,
}) => {
  await page.goto('/#/scan/id-card')
  for (const side of ['人像面', '国徽面']) {
    await expect(page.getByRole('heading', { name: `拍摄身份证${side}` })).toBeVisible()
    await waitForScannerReady(page)
    await page
      .locator('input[type="file"]')
      .nth(1)
      .setInputFiles(path.resolve('tests/e2e/fixtures/document.png'))
    await page.getByRole('button', { name: '确认裁剪' }).click()
    await page.getByRole('button', { name: '保存页面' }).click()
  }

  await page.getByRole('button', { name: '导出', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const original = dialog.getByRole('button', { name: '原尺寸', exact: true })
  const enlarged = dialog.getByRole('button', { name: '放大', exact: true })
  await expect(original).toHaveAttribute('aria-pressed', 'true')
  await expect(
    dialog.getByText('按原尺寸排版正反两面, 每面 85.6 x 53.98 mm.', { exact: true }),
  ).toBeVisible()

  await enlarged.click()
  await expect(enlarged).toHaveAttribute('aria-pressed', 'true')
  await expect(original).toHaveAttribute('aria-pressed', 'false')
  await dialog.getByRole('button', { name: /JPG 图片/ }).click()
  await expect(enlarged).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: /PNG 图片/ }).click()
  await expect(enlarged).toHaveAttribute('aria-pressed', 'true')
  await original.click()
  await dialog.getByRole('button', { name: /PDF 文档/ }).click()
  await expect(original).toHaveAttribute('aria-pressed', 'true')

  const downloadPromise = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '生成并下载' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.pdf$/)
  const pdf = await PDFDocument.load(await readFile((await download.path())!))
  expect(pdf.getPageCount()).toBe(1)
  const size = pdf.getPages()[0].getSize()
  expect((size.width / 72) * 25.4).toBeCloseTo(210)
  expect((size.height / 72) * 25.4).toBeCloseTo(297)
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
