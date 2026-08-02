import { afterEach, describe, expect, it } from 'vitest'
import { bulkPutPages, clearScannerData, db, deleteProject, getProjectWithPages } from './db'
import { DEFAULT_QUAD } from './geometry'
import { DEFAULT_ADJUSTMENTS, SMART_EFFECTS, type ScanPage, type ScanProject } from './types'

afterEach(async () => {
  await clearScannerData()
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
      effects: { ...SMART_EFFECTS },
      adjustments: DEFAULT_ADJUSTMENTS,
      thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
      createdAt: now,
      updatedAt: now,
    })

    await db.projects.put(project)
    await bulkPutPages([makePage('page-2', 1), makePage('page-1', 0)])
    const rawPage = await db.pages.get('page-1')
    expect(rawPage?.source.data.byteLength).toBeGreaterThan(0)
    expect(rawPage?.thumbnail?.data.byteLength).toBeGreaterThan(0)

    const stored = await getProjectWithPages(project.id)
    expect(stored.project?.name).toBe('测试文档')
    expect(stored.pages.map((page) => page.id)).toEqual(['page-1', 'page-2'])
    expect(stored.pages[0].source).toBeInstanceOf(Blob)
    expect(stored.pages[0].thumbnail).toBeInstanceOf(Blob)

    await deleteProject(project.id)
    expect(await db.projects.count()).toBe(0)
    expect(await db.pages.count()).toBe(0)
  })

  it('clears all scan history and exposes no model stores', async () => {
    const now = Date.now()
    await db.projects.put({
      id: 'project-to-clear',
      mode: 'document',
      name: '待清理文档',
      createdAt: now,
      updatedAt: now,
    })

    await clearScannerData()

    expect(await db.projects.count()).toBe(0)
    expect(await db.pages.count()).toBe(0)
    expect(db.tables.map((table) => table.name)).toEqual(['projects', 'pages'])
  })
})
