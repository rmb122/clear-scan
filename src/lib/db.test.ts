import { afterEach, describe, expect, it } from 'vitest'
import { bulkPutPages, clearScannerData, db, deleteAdvancedModel, deleteProject, getProjectWithPages } from './db'
import { DEFAULT_QUAD } from './geometry'
import { DEFAULT_ADJUSTMENTS, type ScanPage, type ScanProject } from './types'

afterEach(async () => {
  await clearScannerData()
  await db.models.clear()
  await db.modelChunks.clear()
})

describe('local scan repository', () => {
  it('stores a project with its ordered pages and deletes them atomically', async () => {
    const now = Date.now()
    const project: ScanProject = {
      id: 'project-1',
      mode: 'document',
      name: '测试文档',
      createdAt: now,
      updatedAt: now,
    }
    const makePage = (id: string, order: number): ScanPage => ({
      id,
      projectId: project.id,
      order,
      role: 'page',
      source: new Blob(['image'], { type: 'image/jpeg' }),
      sourceName: `${id}.jpg`,
      width: 100,
      height: 140,
      corners: DEFAULT_QUAD,
      confidence: 0.8,
      glareLevel: 'none',
      rotation: 0,
      filter: 'smart',
      adjustments: DEFAULT_ADJUSTMENTS,
      advancedCorrection: id === 'page-1' ? {
        fingerprint: 'fingerprint-1',
        modelId: 'docshadow-sd7k-fp16',
        modelVersion: '1.0.0-fp16',
        map: new Blob(['gain-map'], { type: 'image/png' }),
        width: 64,
        height: 64,
        backend: 'wasm',
        inferenceMs: 42,
        createdAt: now,
      } : undefined,
      createdAt: now,
      updatedAt: now,
    })

    await db.projects.put(project)
    await bulkPutPages([makePage('page-2', 1), makePage('page-1', 0)])
    const rawPage = await db.pages.get('page-1')
    expect(rawPage).toBeDefined()
    expect(rawPage?.source.data.byteLength).toBeGreaterThan(0)
    expect(rawPage?.advancedCorrection?.map.data.byteLength).toBeGreaterThan(0)
    const stored = await getProjectWithPages(project.id)
    expect(stored.project?.name).toBe('测试文档')
    expect(stored.pages.map((page) => page.id)).toEqual(['page-1', 'page-2'])
    expect(stored.pages[0].source).toBeInstanceOf(Blob)
    expect(stored.pages[0].advancedCorrection?.map).toBeInstanceOf(Blob)

    await db.models.put({
      id: 'docshadow-sd7k-fp16',
      version: '1.0.0-fp16',
      state: 'ready',
      expectedBytes: 4,
      downloadedBytes: 4,
      sha256: 'test',
    })
    await db.modelChunks.put({
      modelId: 'docshadow-sd7k-fp16',
      index: 0,
      data: new Uint8Array([1, 2, 3, 4]).buffer,
    })
    await deleteAdvancedModel('docshadow-sd7k-fp16')
    expect(await db.models.count()).toBe(0)
    expect(await db.modelChunks.count()).toBe(0)
    expect((await getProjectWithPages(project.id)).pages[0].advancedCorrection?.map.size).toBeGreaterThan(0)

    await deleteProject(project.id)
    expect(await db.projects.count()).toBe(0)
    expect(await db.pages.count()).toBe(0)
  })
})
