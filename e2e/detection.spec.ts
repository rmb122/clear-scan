import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DETECTION_CONFIDENCE_THRESHOLD } from '../src/lib/document-detection'
import type { NormalizedQuad, ScanMode } from '../src/lib/types'

interface DetectionCase {
  fixture: string
  mode: ScanMode
  expected?: Array<[number, number]>
  meanLimit?: number
  maxLimit?: number
}

const cases: DetectionCase[] = [
  {
    fixture: 'document.svg',
    mode: 'document',
    expected: [
      [180, 105],
      [1050, 165],
      [980, 805],
      [115, 735],
    ],
    meanLimit: 0.015,
    maxLimit: 0.03,
  },
  {
    fixture: 'low-contrast.svg',
    mode: 'document',
    expected: [
      [160, 120],
      [1040, 155],
      [985, 790],
      [120, 742],
    ],
    meanLimit: 0.03,
    maxLimit: 0.05,
  },
  {
    fixture: 'complex-background.svg',
    mode: 'document',
    expected: [
      [175, 95],
      [1030, 175],
      [965, 812],
      [105, 720],
    ],
    meanLimit: 0.03,
    maxLimit: 0.05,
  },
  {
    fixture: 'reflective-id.svg',
    mode: 'id-card',
    expected: [
      [170, 185],
      [1040, 220],
      [982, 740],
      [138, 682],
    ],
    meanLimit: 0.04,
    maxLimit: 0.06,
  },
  {
    fixture: 'broken-passport.svg',
    mode: 'passport',
    expected: [
      [210, 175],
      [1000, 140],
      [1040, 675],
      [175, 730],
    ],
    meanLimit: 0.04,
    maxLimit: 0.06,
  },
  {
    fixture: 'passport-inner-frame.svg',
    mode: 'passport',
    expected: [
      [145, 105],
      [1050, 150],
      [1002, 790],
      [100, 735],
    ],
    meanLimit: 0.045,
    maxLimit: 0.07,
  },
  { fixture: 'no-document.svg', mode: 'document' },
]

async function rasterizeSvg(page: Page, fixture: string) {
  const svg = await readFile(path.resolve('e2e/fixtures', fixture), 'utf8')
  const bytes = await page.evaluate(async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }))
    try {
      const image = new Image()
      image.src = url
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = 1200
      canvas.height = 900
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Unable to create fixture canvas')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('Unable to rasterize fixture'))),
          'image/png',
        ),
      )
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    } finally {
      URL.revokeObjectURL(url)
    }
  }, svg)
  return Buffer.from(bytes)
}

async function readDetection(page: Page, sourceName: string) {
  return page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('clear-scan-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const records = await new Promise<
      Array<{
        sourceName: string
        confidence: number
        cornerSource: string
        cropConfirmed: boolean
        corners: NormalizedQuad
      }>
    >((resolve, reject) => {
      const request = database.transaction('pages').objectStore('pages').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    const record = records.find((item) => item.sourceName === name)
    if (!record) throw new Error(`Missing stored detection for ${name}`)
    return {
      confidence: record.confidence,
      cornerSource: record.cornerSource,
      cropConfirmed: record.cropConfirmed,
      corners: record.corners,
    }
  }, sourceName)
}

test('detects difficult document edges and rejects scenes without a document', async ({ page }) => {
  test.setTimeout(180_000)
  for (const scenario of cases) {
    await test.step(scenario.fixture, async () => {
      await page.goto(`/#/scan/${scenario.mode}`)
      const fileName = `${scenario.fixture.replace(/\.svg$/, '')}.png`
      const buffer = await rasterizeSvg(page, scenario.fixture)
      await page.locator('input[type="file"]').nth(1).setInputFiles({
        name: fileName,
        mimeType: 'image/png',
        buffer,
      })
      await expect(page.getByText('确认四个角点')).toBeVisible({
        timeout: 120_000,
      })
      const detection = await readDetection(page, fileName)
      expect(detection.cropConfirmed).toBe(false)

      if (!scenario.expected) {
        expect(detection.confidence).toBeLessThan(DETECTION_CONFIDENCE_THRESHOLD)
        expect(detection.cornerSource).toBe('fallback')
        expect(detection.corners).toEqual([
          { x: 0.04, y: 0.04 },
          { x: 0.96, y: 0.04 },
          { x: 0.96, y: 0.96 },
          { x: 0.04, y: 0.96 },
        ])
        return
      }

      expect(detection.confidence).toBeGreaterThanOrEqual(DETECTION_CONFIDENCE_THRESHOLD)
      expect(detection.cornerSource).toBe('detected')
      const errors = detection.corners.map(
        (corner, index) =>
          Math.hypot(
            corner.x * 1200 - scenario.expected![index][0],
            corner.y * 900 - scenario.expected![index][1],
          ) / 1500,
      )
      const meanError = errors.reduce((sum, error) => sum + error, 0) / errors.length
      expect(meanError).toBeLessThanOrEqual(scenario.meanLimit!)
      expect(Math.max(...errors)).toBeLessThanOrEqual(scenario.maxLimit!)
    })
  }
})

test('keeps the image worker stable across ten consecutive detections', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'One browser run is enough for the worker lifecycle check',
  )
  test.setTimeout(180_000)
  await page.goto('/#/scan/document')
  const buffer = await rasterizeSvg(page, 'low-contrast.svg')

  for (let index = 0; index < 10; index += 1) {
    const fileName = `repeat-${index}.png`
    await page.locator('input[type="file"]').nth(1).setInputFiles({
      name: fileName,
      mimeType: 'image/png',
      buffer,
    })
    await expect(page.getByText('确认四个角点')).toBeVisible({
      timeout: 120_000,
    })
    const detection = await readDetection(page, fileName)
    expect(detection.confidence).toBeGreaterThanOrEqual(DETECTION_CONFIDENCE_THRESHOLD)
    expect(detection.cornerSource).toBe('detected')
    if (index < 9) {
      await page.getByRole('button', { name: '添加页面' }).click()
      await expect(page.getByRole('heading', { name: '添加文档页面' })).toBeVisible()
    }
  }
})
