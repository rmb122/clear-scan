import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const documentFixture = fs.readFileSync(path.resolve('e2e/fixtures/document.png'))

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
}

async function storedColorEffect(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('clear-scan-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const records = await new Promise<Array<{ effects?: { color?: string } }>>((resolve, reject) => {
      const request = database.transaction('pages').objectStore('pages').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return records[0]?.effects?.color
  })
}

test('desktop and mobile shells expose useful empty, install, and fallback states', async ({ page }, testInfo) => {
  for (const [route, heading] of [
    ['/', /清晰扫描仪/],
    ['/history', '扫描记录'],
    ['/settings', '本地图像引擎'],
    ['/scan/document', '添加文档页面'],
  ] as const) {
    await page.goto(route)
    await expect(page.getByRole('heading', { name: heading, exact: typeof heading === 'string' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  }

  await page.goto('/history')
  await expect(page.getByRole('heading', { name: '还没有扫描记录' })).toBeVisible()
  await expect(page.getByRole('link', { name: '开始第一次扫描' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '搜索扫描项目' })).toHaveCount(0)

  const install = page.getByRole('button', { name: '安装应用' })
  await expect(install).toBeVisible()
  const installBox = await install.boundingBox()
  expect(installBox).not.toBeNull()
  expect(installBox!.height).toBeGreaterThanOrEqual(32)
  await install.click()
  await expect(page.getByText('可通过浏览器菜单安装')).toBeVisible()

  if (testInfo.project.name === 'mobile-chromium') {
    await page.setViewportSize({ width: 320, height: 568 })
    await page.goto('/')
    await expect(page.getByRole('button', { name: '安装应用' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  }

  await page.goto('/scan/document')
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not an image'),
    })
  await expect(page.getByText('没有可用的图片')).toBeVisible()
})

test('web camera failure is actionable instead of staying busy', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'mediaDevices', {
      configurable: true,
      get: () => undefined,
    })
  })
  await page.goto('/scan/document')
  await page.getByRole('button', { name: '使用网页摄像头' }).click()
  await expect(page.getByRole('heading', { name: '摄像头拍摄' })).toBeVisible()
  await expect(page.getByText(/网页摄像头需要|没有提供网页摄像头接口/)).toBeVisible()
  await expect(page.getByRole('button', { name: '拍照' })).toBeDisabled()
})

test('scan editing stays reachable and survives rapid page changes on desktop and mobile', async ({
  page,
}, testInfo) => {
  await page.goto('/scan/document')
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles([
      { name: 'page-one.png', mimeType: 'image/png', buffer: documentFixture },
      { name: 'page-two.png', mimeType: 'image/png', buffer: documentFixture },
    ])
  await expect(page.getByText('确认四个角点')).toBeVisible({ timeout: 120_000 })
  const projectPath = new URL(page.url()).pathname

  const handles = page.getByRole('button', { name: /拖动第 \d 个裁剪点/ })
  await expect(handles).toHaveCount(4)
  for (let index = 0; index < 4; index += 1) {
    const box = await handles.nth(index).boundingBox()
    expect(box).not.toBeNull()
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44)
  }

  const deletePage = page.getByRole('button', { name: '删除第 1 页' })
  await expect(deletePage).toBeVisible()
  const deleteBox = await deletePage.boundingBox()
  expect(deleteBox).not.toBeNull()
  expect(Math.min(deleteBox!.width, deleteBox!.height)).toBeGreaterThanOrEqual(36)

  if (testInfo.project.name === 'desktop-chromium') {
    const editorBox = await page.locator('section.paper-grid').boundingBox()
    const viewport = page.viewportSize()
    expect(editorBox).not.toBeNull()
    expect(viewport).not.toBeNull()
    expect(editorBox!.y + editorBox!.height).toBeLessThanOrEqual(viewport!.height + 1)
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    )
    expect(pageOverflow).toBeLessThanOrEqual(1)
  }

  await page.getByRole('button', { name: '确认裁剪' }).click()
  await expect(page.getByRole('img', { name: '扫描增强预览' })).toBeVisible({ timeout: 120_000 })
  if (testInfo.project.name === 'mobile-chromium') {
    await expect
      .poll(async () => Math.round((await page.locator('section.paper-grid').boundingBox())?.y ?? -1))
      .toBeGreaterThanOrEqual(63)
    expect(Math.round((await page.locator('section.paper-grid').boundingBox())!.y)).toBeLessThanOrEqual(65)
  }
  const blackWhite = page.getByRole('button', { name: '黑白', exact: true })
  await blackWhite.click()
  await expect(blackWhite).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '打开第 2 页' }).click()
  await expect(page.getByRole('button', { name: '打开第 2 页' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '打开第 1 页' }).click()
  await expect(blackWhite).toHaveAttribute('aria-pressed', 'true')

  const grayscale = page.getByRole('button', { name: '灰度', exact: true })
  await grayscale.click()
  await expect(grayscale).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('link', { name: '首页', exact: true }).click()
  await expect(page.getByRole('heading', { name: /清晰扫描仪/ })).toBeVisible()
  await expect.poll(() => storedColorEffect(page)).toBe('grayscale')

  await page.goto(projectPath)
  await expect(page.getByText('调整扫描效果')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('button', { name: '灰度', exact: true })).toHaveAttribute('aria-pressed', 'true')

  if (testInfo.project.name === 'mobile-chromium') {
    const save = page.getByRole('button', { name: '保存页面' })
    await save.scrollIntoViewIfNeeded()
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const saveBox = await save.boundingBox()
    const navigationBox = await page.getByRole('navigation', { name: '移动端主导航' }).boundingBox()
    expect(saveBox).not.toBeNull()
    expect(navigationBox).not.toBeNull()
    expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(navigationBox!.y)
  }
  await expectNoHorizontalOverflow(page)
})
