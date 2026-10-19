import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { holdNextThumbnailEncoding, waitForScannerReady } from './helpers'

const documentFixture = fs.readFileSync(path.resolve('tests/e2e/fixtures/document.png'))

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
}

async function readHeaderLayout(page: Page) {
  return page
    .getByRole('banner', { includeHidden: true })
    .locator('a:visible, button:visible, nav:visible')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const { x, width } = element.getBoundingClientRect()
        return { x, width }
      }),
    )
}

async function storedPageState(page: Page, sourceName: string) {
  return page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('clear-scan-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const records = await new Promise<
      Array<{ sourceName: string; cropConfirmed?: boolean; effects?: { color?: string } }>
    >((resolve, reject) => {
      const request = database.transaction('pages').objectStore('pages').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    const record = records.find((item) => item.sourceName === name)
    return {
      color: record?.effects?.color,
      cropConfirmed: record?.cropConfirmed,
    }
  }, sourceName)
}

async function seedEditableProject(page: Page) {
  await page.goto('/')
  await page.evaluate(async (bytes) => {
    const dbPath = '/src/lib/db.ts'
    const fixturePath = '/tests/support/scan-fixtures.ts'
    const { db, putPage } = await import(dbPath)
    const { makePage, makeProject } = await import(fixturePath)
    const source = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const bitmap = await createImageBitmap(source)
    await db.projects.put(makeProject())
    await putPage(makePage({ source, width: bitmap.width, height: bitmap.height }))
    bitmap.close()
  }, Array.from(documentFixture))
  await page.goto('/#/project/project-1')
}

test.describe('navigation with visible scrollbars', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Requires desktop scrollbars')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    // Use classic scrollbars even on systems that default to overlay scrollbars.
    await page.addStyleTag({ content: 'html::-webkit-scrollbar { width: 16px; }' })
  })

  test('keeps the header aligned when switching between home and empty history', async ({
    page,
  }) => {
    await expect(page.getByRole('heading', { name: /清晰扫描仪/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: '还没有扫描记录' })).toBeVisible()
    expect(
      await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth),
    ).toBe(16)
    const pageOverflowsVertically = () =>
      page.evaluate(
        () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
      )
    expect(await pageOverflowsVertically()).toBe(true)

    const navigation = page.getByRole('navigation', { name: '主导航', exact: true })
    const initialLayout = await readHeaderLayout(page)

    await navigation.getByRole('link', { name: '扫描记录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '扫描记录', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '还没有扫描记录' })).toBeVisible()
    expect(await pageOverflowsVertically()).toBe(false)
    expect(await readHeaderLayout(page)).toEqual(initialLayout)
    await expectNoHorizontalOverflow(page)

    await navigation.getByRole('link', { name: '首页', exact: true }).click()
    await expect(page.getByRole('heading', { name: /清晰扫描仪/ })).toBeVisible()
    expect(await pageOverflowsVertically()).toBe(true)
    expect(await readHeaderLayout(page)).toEqual(initialLayout)
    await expectNoHorizontalOverflow(page)
  })

  test('keeps the header aligned when filtering history and toggling its dialog', async ({
    page,
  }) => {
    await page.evaluate(async () => {
      const dbPath = '/src/lib/db.ts'
      const fixturePath = '/tests/support/scan-fixtures.ts'
      const { db } = await import(dbPath)
      const { makeProject } = await import(fixturePath)
      await db.projects.bulkPut(
        Array.from({ length: 8 }, (_, index) => makeProject({ id: `project-${index}` })),
      )
    })
    await page
      .getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('link', { name: '扫描记录', exact: true })
      .click()
    await expect(page.getByRole('article')).toHaveCount(8)
    const initialLayout = await readHeaderLayout(page)

    for (const query of ['', 'no matching projects']) {
      await page.getByRole('textbox', { name: '搜索扫描项目' }).fill(query)
      await expect(page.getByRole('article')).toHaveCount(query ? 0 : 8)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
        ),
      ).toBe(!query)
      expect(await readHeaderLayout(page)).toEqual(initialLayout)

      await page.getByRole('button', { name: '清空所有历史数据' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.locator('body')).toHaveAttribute('data-scroll-locked', '1')
      expect(await readHeaderLayout(page)).toEqual(initialLayout)

      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')
      expect(await readHeaderLayout(page)).toEqual(initialLayout)
    }
  })
})

test('scan project names stay inline with scan details and save direct edits on all screens', async ({
  page,
}, testInfo) => {
  await seedEditableProject(page)
  const projectName = page.getByRole('textbox', { name: '项目名称' })
  await expect(projectName).toHaveValue('测试文档')

  const [modeBox, countBox, titleBox] = await Promise.all([
    page.getByText('文档扫描', { exact: true }).boundingBox(),
    page.getByText('1 页', { exact: true }).boundingBox(),
    projectName.boundingBox(),
  ])
  expect(modeBox).not.toBeNull()
  expect(countBox).not.toBeNull()
  expect(titleBox).not.toBeNull()
  expect(titleBox!.x).toBeGreaterThan(countBox!.x + countBox!.width)
  for (const box of [modeBox!, countBox!]) {
    expect(
      Math.abs(box.y + box.height / 2 - titleBox!.y - titleBox!.height / 2),
    ).toBeLessThanOrEqual(1)
  }

  await expect(page.getByRole('button', { name: '重命名项目' })).toHaveCount(0)
  const pencil = page.locator('label').filter({ has: projectName }).locator('svg')
  await expect(pencil).toBeVisible()
  const [pencilBox, nameBox] = await Promise.all([pencil.boundingBox(), projectName.boundingBox()])
  expect(pencilBox).not.toBeNull()
  expect(nameBox).not.toBeNull()
  expect(pencilBox!.x + pencilBox!.width).toBeLessThan(nameBox!.x)
  await projectName.click()
  await expect(projectName).toBeFocused()
  await expect(page.getByText('修改自动保存', { exact: true })).toHaveCount(0)

  const renamed = '会议纪要与扫描归档资料'.repeat(8)
  await projectName.fill(renamed)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const dbPath = '/src/lib/db.ts'
        const { db } = await import(dbPath)
        return (await db.projects.get('project-1'))?.name
      }),
    )
    .toBe(renamed)
  await expect(projectName).toBeFocused()
  await projectName.press('Tab')
  await page.reload()
  await expect(projectName).toHaveValue(renamed)
  await expectNoHorizontalOverflow(page)
  await expect(page.getByRole('button', { name: '导出', exact: true })).toBeVisible()

  if (testInfo.project.name === 'mobile-chromium') {
    await page.setViewportSize({ width: 320, height: 568 })
    await expectNoHorizontalOverflow(page)
    await expect(projectName).toBeVisible()
    await projectName.click()
    await expect(projectName).toBeFocused()
    await expectNoHorizontalOverflow(page)
    await expect(page.getByRole('button', { name: '导出', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '切换为英语' }).click()
    const pageCount = page.getByText('1 page', { exact: true })
    const exportButton = page.getByRole('button', { name: 'Export', exact: true })
    await expect(pageCount).toBeVisible()
    const [countBox, exportBox] = await Promise.all([
      pageCount.boundingBox(),
      exportButton.boundingBox(),
    ])
    expect(countBox).not.toBeNull()
    expect(exportBox).not.toBeNull()
    expect(countBox!.x + countBox!.width).toBeLessThanOrEqual(exportBox!.x)
    await exportButton.click({ trial: true })
  }
})

test('desktop and mobile shells expose useful empty, install, and fallback states', async ({
  page,
}, testInfo) => {
  for (const [route, heading] of [
    ['/', /清晰扫描仪/],
    ['/#/history', '扫描记录'],
    ['/#/scan/document', '添加文档页面'],
  ] as const) {
    await page.goto(route)
    await expect(
      page.getByRole('heading', {
        name: heading,
        exact: typeof heading === 'string',
      }),
    ).toBeVisible()
    await expectNoHorizontalOverflow(page)
  }

  await page.goto('/')
  await expect(page.getByRole('link', { name: '设置', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '本地图像引擎设置' })).toHaveCount(0)
  const sourceLink = page.getByRole('link', { name: '查看项目源代码' })
  await expect(sourceLink).toBeVisible()
  await expect(sourceLink).toHaveAttribute('href', 'https://github.com/rmb122/clear-scan')
  if (testInfo.project.name === 'mobile-chromium') {
    await expect(sourceLink).toHaveText('')
  } else {
    await expect(sourceLink).toHaveText('源代码')
    const navigationBox = await page.getByRole('navigation', { name: '主导航' }).boundingBox()
    const headerBox = await page.getByRole('banner').boundingBox()
    expect(navigationBox).not.toBeNull()
    expect(headerBox).not.toBeNull()
    expect(
      Math.abs(navigationBox!.x + navigationBox!.width / 2 - headerBox!.x - headerBox!.width / 2),
    ).toBeLessThanOrEqual(1)
  }
  await page.goto('/#/settings')
  await expect(page.getByRole('heading', { name: /清晰扫描仪/ })).toBeVisible()
  await expect.poll(() => new URL(page.url()).hash).toBe('#/')

  await page.goto('/#/history')
  await expect(page.getByRole('heading', { name: '还没有扫描记录' })).toBeVisible()
  await expect(page.getByRole('link', { name: '开始第一次扫描' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '搜索扫描项目' })).toHaveCount(0)

  const install = page.getByRole('button', { name: '安装应用' })
  await expect(install).toBeVisible()
  if (testInfo.project.name === 'desktop-chromium') {
    const readTypography = (selector: typeof sourceLink) =>
      selector.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
        }
      })
    const [sourceTypography, installTypography] = await Promise.all([
      readTypography(sourceLink),
      readTypography(install),
    ])
    expect(sourceTypography).toEqual(installTypography)
    expect(sourceTypography).toMatchObject({ fontSize: '14px', fontWeight: '600' })
  }
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

  await page.goto('/#/scan/document')
  await waitForScannerReady(page)
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
  await page.goto('/#/scan/document')
  await page.getByRole('button', { name: '使用网页摄像头' }).click()
  await expect(page.getByRole('heading', { name: '摄像头拍摄' })).toBeVisible()
  await expect(page.getByText(/网页摄像头需要|没有提供网页摄像头接口/)).toBeVisible()
  await expect(page.getByRole('button', { name: '拍照' })).toBeDisabled()
})

test('scan editing stays reachable and survives rapid page changes on desktop and mobile', async ({
  page,
}, testInfo) => {
  await page.goto('/#/scan/document')
  await waitForScannerReady(page)
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles([
      { name: 'page-one.png', mimeType: 'image/png', buffer: documentFixture },
      { name: 'page-two.png', mimeType: 'image/png', buffer: documentFixture },
    ])
  await expect(page.getByText('确认四个角点')).toBeVisible({
    timeout: 120_000,
  })
  await expect(page).toHaveURL(/\/project\//)
  const projectUrl = page.url()

  const handles = page.getByRole('button', { name: /拖动第 \d 个裁剪点/ })
  await expect(handles).toHaveCount(4)
  for (let index = 0; index < 4; index += 1) {
    const box = await handles.nth(index).boundingBox()
    expect(box).not.toBeNull()
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44)
  }

  await expect(page.getByText('已预识别边缘，请人工确认')).toBeVisible()
  const firstHandleBox = await handles.first().boundingBox()
  expect(firstHandleBox).not.toBeNull()
  await page.mouse.move(
    firstHandleBox!.x + firstHandleBox!.width / 2,
    firstHandleBox!.y + firstHandleBox!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    firstHandleBox!.x + firstHandleBox!.width / 2 + 8,
    firstHandleBox!.y + firstHandleBox!.height / 2 + 6,
  )
  await expect
    .poll(async () => {
      const moved = await handles.first().boundingBox()
      return moved ? moved.x - firstHandleBox!.x : 0
    })
    .toBeGreaterThan(4)
  await expect(page.getByText('已预识别边缘，请人工确认')).toBeVisible()
  await page.mouse.up()
  await expect(page.getByText('已手动调整边缘')).toBeVisible()
  await expect(page.getByText('已手动调整，等待确认')).toBeVisible()

  const deletePage = page.getByRole('button', { name: '删除第 1 页' })
  await expect(deletePage).toBeVisible()
  const deleteBox = await deletePage.boundingBox()
  expect(deleteBox).not.toBeNull()
  expect(Math.min(deleteBox!.width, deleteBox!.height)).toBeGreaterThanOrEqual(36)
  await deletePage.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('heading', { name: '删除第 1 页？' })).toBeVisible()
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const redetect = page.getByRole('button', { name: '重新识别' })
  const confirmCrop = page.getByRole('button', { name: '确认裁剪' })
  const [redetectBox, confirmCropBox] = await Promise.all([
    redetect.boundingBox(),
    confirmCrop.boundingBox(),
  ])
  expect(redetectBox).not.toBeNull()
  expect(confirmCropBox).not.toBeNull()
  expect(redetectBox!.height).toBe(confirmCropBox!.height)
  expect(redetectBox!.width).toBe(confirmCropBox!.width)

  if (testInfo.project.name === 'desktop-chromium') {
    const editorBox = await page.locator('section.paper-grid').boundingBox()
    const viewport = page.viewportSize()
    expect(editorBox).not.toBeNull()
    expect(viewport).not.toBeNull()
    expect(editorBox!.y + editorBox!.height).toBeLessThanOrEqual(viewport!.height + 1)
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    )
    expect(pageOverflow).toBe(0)
  }

  await confirmCrop.click()
  await expect(page.getByRole('img', { name: '扫描增强预览' })).toBeVisible({
    timeout: 120_000,
  })
  const originalPreset = page.getByRole('button', { name: '原版', exact: true })
  const smartPreset = page.getByRole('button', { name: '智能增强', exact: true })
  const [originalPresetBox, smartPresetBox] = await Promise.all([
    originalPreset.boundingBox(),
    smartPreset.boundingBox(),
  ])
  expect(originalPresetBox).not.toBeNull()
  expect(smartPresetBox).not.toBeNull()
  expect(originalPresetBox!.y).toBe(smartPresetBox!.y)
  expect(originalPresetBox!.height).toBe(smartPresetBox!.height)
  expect(originalPresetBox!.x).toBeLessThan(smartPresetBox!.x)
  if (testInfo.project.name === 'mobile-chromium') {
    await expect
      .poll(async () =>
        Math.round((await page.locator('section.paper-grid').boundingBox())?.y ?? -1),
      )
      .toBeGreaterThanOrEqual(63)
    expect(
      Math.round((await page.locator('section.paper-grid').boundingBox())!.y),
    ).toBeLessThanOrEqual(65)
  }
  const preview = page.getByRole('img', { name: '扫描增强预览' })
  const counterclockwise = page.getByRole('button', { name: '逆时针旋转 90°' })
  const clockwise = page.getByRole('button', { name: '顺时针旋转 90°' })
  const [counterclockwiseBox, clockwiseBox] = await Promise.all([
    counterclockwise.boundingBox(),
    clockwise.boundingBox(),
  ])
  expect(counterclockwiseBox).not.toBeNull()
  expect(clockwiseBox).not.toBeNull()
  expect(counterclockwiseBox!.x).toBeLessThan(clockwiseBox!.x)

  const originalPreview = await preview.getAttribute('src')
  await counterclockwise.click()
  await expect.poll(() => preview.getAttribute('src')).not.toBe(originalPreview)
  const counterclockwisePreview = await preview.getAttribute('src')
  await clockwise.click()
  await expect.poll(() => preview.getAttribute('src')).not.toBe(counterclockwisePreview)

  const blackWhite = page.getByRole('button', { name: '黑白', exact: true })
  await blackWhite.click()
  await expect(blackWhite).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '打开第 2 页' }).click()
  await expect(page.getByRole('button', { name: '打开第 2 页' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: '打开第 1 页' }).click()
  await expect(blackWhite).toHaveAttribute('aria-pressed', 'true')

  await expect(page.getByRole('button', { name: '保存页面' })).toBeEnabled()
  const thumbnailSave = await holdNextThumbnailEncoding(page)
  try {
    await page.getByRole('button', { name: '保存页面' }).click()
    await thumbnailSave.waitUntilBlocked()
    const grayscale = page.getByRole('button', { name: '灰度', exact: true })
    await grayscale.click()
    await expect(grayscale).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('link', { name: '首页', exact: true }).click()
    await expect(page.getByRole('heading', { name: /清晰扫描仪/ })).toBeVisible()
    // Reopen while thumbnail encoding is pending. Metadata must already be
    // available without waiting for the old component's thumbnail queue.
    await page
      .locator(`a[href="${new URL(projectUrl).hash}"]`)
      .filter({ has: page.getByRole('heading') })
      .click()
    await expect(page.getByRole('button', { name: '灰度', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  } finally {
    await thumbnailSave.release()
  }

  await expect(page.getByText('调整扫描效果')).toBeVisible({
    timeout: 120_000,
  })
  await expect(page.getByRole('button', { name: '灰度', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect
    .poll(async () => (await storedPageState(page, 'page-one.png')).color)
    .toBe('grayscale')
  await page.getByRole('button', { name: '调整边缘' }).click()
  await expect(page.getByText('已手动调整边缘')).toBeVisible()
  await expect(page.getByRole('img', { name: '扫描增强预览' })).toHaveCount(0)
  await expect
    .poll(async () => (await storedPageState(page, 'page-one.png')).cropConfirmed)
    .toBe(false)
  await page.reload()
  await expect(page.getByText('确认四个角点')).toBeVisible()
  await expect(page.getByText('已手动调整边缘')).toBeVisible()
  await expect(page.getByRole('img', { name: '待裁剪文档' })).toBeVisible()
  await expect
    .poll(() =>
      page
        .getByRole('img', { name: '待裁剪文档' })
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0)
  await page.getByRole('button', { name: '确认裁剪' }).click()
  await expect(page.getByRole('status')).toBeVisible()
  await expect
    .poll(async () => (await storedPageState(page, 'page-one.png')).cropConfirmed)
    .toBe(true)
  await expect(page.getByText('调整扫描效果')).toBeVisible()
  await expect(page.getByRole('img', { name: '扫描增强预览' })).toBeVisible({
    timeout: 120_000,
  })

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
  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByRole('button', { name: '黑白', exact: true }).dispatchEvent('click')
    await expect(page.getByRole('button', { name: '黑白', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await page.getByRole('link', { name: '扫一扫', exact: true }).dispatchEvent('click')
    await expect(page.getByRole('heading', { name: '添加文档页面' })).toBeVisible()
    await expect
      .poll(async () => (await storedPageState(page, 'page-one.png')).color)
      .toBe('black-white')
  }
})

test.describe('project persistence across browser navigation', () => {
  for (const pendingThumbnail of [false, true]) {
    test(`keeps an immediate edit across reload with pending thumbnail: ${pendingThumbnail}`, async ({
      page,
    }) => {
      await seedEditableProject(page)
      await expect(page.getByRole('button', { name: '保存页面' })).toBeEnabled()
      if (pendingThumbnail) {
        const thumbnailSave = await holdNextThumbnailEncoding(page)
        await page.getByRole('button', { name: '保存页面' }).click()
        await thumbnailSave.waitUntilBlocked()
        // Reload intentionally discards this document and its pending encoder.
      }
      await page.getByRole('button', { name: '灰度', exact: true }).click()
      await page.reload()
      await expect(page.getByRole('button', { name: '灰度', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect((await storedPageState(page, 'page.png')).color).toBe('grayscale')
    })
  }
})
