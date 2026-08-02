import { expect, test, type Page } from '@playwright/test'

interface RegionStats {
  red: number
  green: number
  blue: number
  luma: number
  saturation: number
  deviation: number
  gradient: number
  whiteRatio: number
  blackRatio: number
}

async function waitForPreviewChange(page: Page, previous?: string | null) {
  const image = page.getByRole('img', { name: '扫描增强预览' })
  await expect(image).toBeVisible({ timeout: 120_000 })
  if (previous) await expect.poll(() => image.getAttribute('src')).not.toBe(previous)
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0))
    .toBe(true)
  return image.getAttribute('src')
}

async function createQualityFixture(page: Page) {
  const bytes = await page.evaluate(async () => {
    const width = 900
    const height = 1200
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    const x = (value: number) => width * (0.04 + value * 0.92)
    const y = (value: number) => height * (0.04 + value * 0.92)

    const paper = context.createLinearGradient(0, 0, width, height)
    paper.addColorStop(0, '#dfd1b5')
    paper.addColorStop(0.58, '#eee3cc')
    paper.addColorStop(1, '#f4ecd9')
    context.fillStyle = paper
    context.fillRect(0, 0, width, height)

    context.fillStyle = '#c94c42'
    context.fillRect(x(0.12), y(0.1), x(0.31) - x(0.12), y(0.19) - y(0.1))
    context.fillStyle = '#367da7'
    context.fillRect(x(0.62), y(0.1), x(0.86) - x(0.62), y(0.23) - y(0.1))
    context.fillStyle = '#31414d'
    context.fillRect(x(0.13), y(0.32), x(0.83) - x(0.13), y(0.346) - y(0.32))
    context.fillStyle = '#88877d'
    context.fillRect(x(0.13), y(0.42), x(0.72) - x(0.13), y(0.438) - y(0.42))
    context.fillStyle = '#66736f'
    for (let row = 0; row < 4; row += 1) {
      context.fillRect(x(0.13), y(0.52 + row * 0.045), x(0.78 - row * 0.06) - x(0.13), Math.max(2, y(0.526) - y(0.52)))
    }
    context.fillStyle = '#328d72'
    context.fillRect(x(0.15), y(0.69), x(0.31) - x(0.15), y(0.78) - y(0.69))

    let seed = 0x51f15e
    for (let index = 0; index < 9_000; index += 1) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      const px = seed % width
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      const py = seed % height
      const dark = (seed & 1) === 0
      context.fillStyle = dark ? 'rgba(54,64,68,.11)' : 'rgba(255,255,255,.11)'
      context.fillRect(px, py, 1, 1)
    }

    const shadow = context.createLinearGradient(0, 0, x(0.62), 0)
    shadow.addColorStop(0, 'rgba(28,48,70,.48)')
    shadow.addColorStop(0.68, 'rgba(38,54,72,.2)')
    shadow.addColorStop(1, 'rgba(38,54,72,0)')
    context.fillStyle = shadow
    context.fillRect(0, 0, x(0.64), height)

    const foldShadow = context.createLinearGradient(0, y(0.7), 0, height)
    foldShadow.addColorStop(0, 'rgba(73,58,48,0)')
    foldShadow.addColorStop(1, 'rgba(73,58,48,.22)')
    context.fillStyle = foldShadow
    context.fillRect(0, y(0.7), width, height - y(0.7))

    const glare = context.createRadialGradient(x(0.75), y(0.165), 2, x(0.75), y(0.165), x(0.1) - x(0))
    glare.addColorStop(0, 'rgba(255,255,255,.96)')
    glare.addColorStop(0.42, 'rgba(255,255,255,.72)')
    glare.addColorStop(1, 'rgba(255,255,255,0)')
    context.fillStyle = glare
    context.fillRect(x(0.62), y(0.1), x(0.86) - x(0.62), y(0.23) - y(0.1))

    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  return Buffer.from(bytes)
}

async function readRegions(page: Page) {
  return page.getByRole('img', { name: '扫描增强预览' }).evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const stats = (x0: number, x1: number, y0: number, y1: number): RegionStats => {
      const samples: number[] = []
      let red = 0
      let green = 0
      let blue = 0
      let saturation = 0
      let gradient = 0
      let white = 0
      let black = 0
      let count = 0
      const left = Math.floor(canvas.width * x0)
      const right = Math.floor(canvas.width * x1)
      const top = Math.floor(canvas.height * y0)
      const bottom = Math.floor(canvas.height * y1)
      for (let y = top; y < bottom; y += 2) {
        let previous = 0
        for (let x = left; x < right; x += 2) {
          const offset = (y * canvas.width + x) * 4
          const r = pixels[offset]
          const g = pixels[offset + 1]
          const b = pixels[offset + 2]
          const light = r * 0.299 + g * 0.587 + b * 0.114
          red += r
          green += g
          blue += b
          saturation += Math.max(r, g, b) - Math.min(r, g, b)
          if (x > left) gradient += Math.abs(light - previous)
          previous = light
          if (light >= 245) white += 1
          if (light <= 45) black += 1
          samples.push(light)
          count += 1
        }
      }
      const luma = samples.reduce((sum, value) => sum + value, 0) / count
      const variance = samples.reduce((sum, value) => sum + (value - luma) ** 2, 0) / count
      return {
        red: red / count,
        green: green / count,
        blue: blue / count,
        luma,
        saturation: saturation / count,
        deviation: Math.sqrt(variance),
        gradient: gradient / count,
        whiteRatio: white / count,
        blackRatio: black / count,
      }
    }
    return {
      leftPaper: stats(0.12, 0.26, 0.255, 0.29),
      rightPaper: stats(0.72, 0.86, 0.255, 0.29),
      darkInk: stats(0.18, 0.72, 0.322, 0.344),
      darkAround: stats(0.18, 0.72, 0.285, 0.305),
      lowInk: stats(0.18, 0.67, 0.421, 0.437),
      lowAround: stats(0.18, 0.67, 0.382, 0.4),
      redMark: stats(0.14, 0.28, 0.12, 0.175),
      redHalo: stats(0.14, 0.28, 0.075, 0.095),
      blueMark: stats(0.63, 0.67, 0.13, 0.2),
      glare: stats(0.735, 0.775, 0.145, 0.185),
      fineText: stats(0.18, 0.65, 0.515, 0.665),
      noisePaper: stats(0.55, 0.85, 0.82, 0.9),
    }
  })
}

async function selectEffect(page: Page, category: string, effect: string, previous: string | null) {
  const group = page.getByRole('group', { name: category })
  const button = group.getByRole('button', { name: effect, exact: true })
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  return waitForPreviewChange(page, previous)
}

test('desktop and mobile render market-style document enhancement', async ({ page }) => {
  await page.goto('/scan/document')
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles({
      name: 'quality-fixture.png',
      mimeType: 'image/png',
      buffer: await createQualityFixture(page),
    })
  await expect(page.getByText('确认四个角点')).toBeVisible({ timeout: 120_000 })
  await page.getByRole('button', { name: '确认裁剪' }).click()
  const initial = await waitForPreviewChange(page)
  const smart = await readRegions(page)
  await page.getByRole('button', { name: '原版', exact: true }).click()
  const originalSource = await waitForPreviewChange(page, initial)
  const original = await readRegions(page)

  const shadowSource = await selectEffect(page, '阴影修复', '标准去阴影', originalSource)
  const shadow = await readRegions(page)
  await selectEffect(page, '阴影修复', '关闭', shadowSource)

  const glareBefore = await page.getByRole('img', { name: '扫描增强预览' }).getAttribute('src')
  const glareSource = await selectEffect(page, '反光修复', '去反光', glareBefore)
  const glare = await readRegions(page)
  await selectEffect(page, '反光修复', '关闭', glareSource)

  const colorBefore = await page.getByRole('img', { name: '扫描增强预览' }).getAttribute('src')
  const colorSource = await selectEffect(page, '色彩风格', '彩色增强', colorBefore)
  const color = await readRegions(page)
  const graySource = await selectEffect(page, '色彩风格', '灰度', colorSource)
  const grayscale = await readRegions(page)
  const blackWhiteSource = await selectEffect(page, '色彩风格', '黑白', graySource)
  const blackWhite = await readRegions(page)
  await selectEffect(page, '阴影修复', '标准去阴影', blackWhiteSource)
  const combinedBlackWhite = await readRegions(page)

  const combinedSource = await page.getByRole('img', { name: '扫描增强预览' }).getAttribute('src')
  await page.getByRole('button', { name: '原版', exact: true }).click()
  const detailBaseSource = await waitForPreviewChange(page, combinedSource)
  await selectEffect(page, '细节增强', '加锐', detailBaseSource)
  const sharpen = await readRegions(page)

  const originalShadowVariation = Math.abs(original.rightPaper.luma - original.leftPaper.luma)
  const correctedShadowVariation = Math.abs(shadow.rightPaper.luma - shadow.leftPaper.luma)
  expect(correctedShadowVariation).toBeLessThan(originalShadowVariation * 0.42)
  expect(shadow.darkAround.luma - shadow.darkInk.luma).toBeGreaterThan(
    (original.darkAround.luma - original.darkInk.luma) * 0.95,
  )

  expect(glare.glare.luma).toBeLessThan(original.glare.luma - 10)
  expect(glare.glare.saturation).toBeGreaterThan(original.glare.saturation * 1.6)
  expect(glare.blueMark.saturation).toBeGreaterThan(original.blueMark.saturation * 0.95)

  expect(Math.min(color.leftPaper.luma, color.rightPaper.luma)).toBeGreaterThan(242)
  expect(Math.abs(color.rightPaper.luma - color.leftPaper.luma)).toBeLessThan(4)
  expect(Math.max(color.leftPaper.saturation, color.rightPaper.saturation)).toBeLessThan(4)
  expect(color.redMark.saturation).toBeGreaterThan(original.redMark.saturation * 1.3)
  expect(color.blueMark.saturation).toBeGreaterThan(original.blueMark.saturation * 1.3)
  expect(color.lowAround.luma - color.lowInk.luma).toBeGreaterThan(
    (original.lowAround.luma - original.lowInk.luma) * 1.35,
  )
  expect(color.noisePaper.deviation).toBeLessThan(2)

  expect(Math.abs(grayscale.rightPaper.red - grayscale.rightPaper.green)).toBeLessThan(0.5)
  expect(Math.min(grayscale.leftPaper.luma, grayscale.rightPaper.luma)).toBeGreaterThan(235)
  expect(Math.abs(grayscale.rightPaper.luma - grayscale.leftPaper.luma)).toBeLessThan(10)
  expect(grayscale.lowAround.luma - grayscale.lowInk.luma).toBeGreaterThan(
    (original.lowAround.luma - original.lowInk.luma) * 1.7,
  )
  expect(grayscale.noisePaper.deviation).toBeLessThan(2)

  expect(blackWhite.leftPaper.whiteRatio).toBeGreaterThan(0.995)
  expect(blackWhite.rightPaper.whiteRatio).toBeGreaterThan(0.995)
  expect(blackWhite.darkInk.blackRatio).toBeGreaterThan(0.98)
  expect(blackWhite.lowInk.blackRatio).toBeGreaterThan(0.98)
  expect(blackWhite.redMark.blackRatio).toBeGreaterThan(0.95)
  expect(blackWhite.blueMark.blackRatio).toBeGreaterThan(0.95)
  expect(blackWhite.fineText.blackRatio).toBeGreaterThan(0.1)
  expect(blackWhite.noisePaper.blackRatio).toBeLessThan(0.005)
  expect(combinedBlackWhite.leftPaper.whiteRatio).toBeGreaterThan(0.995)
  expect(combinedBlackWhite.darkInk.blackRatio).toBeGreaterThan(0.98)
  expect(combinedBlackWhite.redMark.blackRatio).toBeGreaterThan(0.95)
  expect(combinedBlackWhite.noisePaper.blackRatio).toBeLessThan(0.005)

  expect(sharpen.fineText.gradient).toBeGreaterThan(original.fineText.gradient * 1.1)
  expect(sharpen.noisePaper.deviation).toBeLessThan(original.noisePaper.deviation * 1.12)

  expect(Math.min(smart.leftPaper.luma, smart.rightPaper.luma)).toBeGreaterThan(242)
  expect(Math.abs(smart.rightPaper.luma - smart.leftPaper.luma)).toBeLessThan(4)
  expect(smart.redMark.saturation).toBeGreaterThan(original.redMark.saturation)
  expect(smart.redHalo.luma).toBeGreaterThan(242)
  expect(smart.redHalo.saturation).toBeLessThan(5)
  expect(smart.lowAround.luma - smart.lowInk.luma).toBeGreaterThan(original.lowAround.luma - original.lowInk.luma)
})
