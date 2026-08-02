import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bulkPutPages,
  clearScannerData,
  db,
  deleteProject,
  getProjectWithPages,
  updatePageMetadata,
  updatePageWithThumbnail,
} from './db'
import { DEFAULT_QUAD } from './geometry'
import {
  DEFAULT_ADJUSTMENTS,
  DEFAULT_WHITENING_STRENGTH,
  SMART_EFFECTS,
  type EnhancementSettings,
  type ScanPage,
  type ScanProject,
} from './types'

afterEach(async () => {
  vi.restoreAllMocks()
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
      cornerSource: 'detected',
      cropConfirmed: false,
      glareLevel: 'none',
      rotation: 0,
      effects: { ...SMART_EFFECTS },
      adjustments: DEFAULT_ADJUSTMENTS,
      thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
      createdAt: now,
      updatedAt: now,
    })

    const firstPage = makePage('page-1', 0)
    await db.projects.put(project)
    await bulkPutPages([makePage('page-2', 1), firstPage])
    const rawPage = await db.pages.get('page-1')
    expect(rawPage?.source.data.byteLength).toBeGreaterThan(0)
    expect(rawPage?.thumbnail?.data.byteLength).toBeGreaterThan(0)

    const stored = await getProjectWithPages(project.id)
    expect(stored.project?.name).toBe('测试文档')
    expect(stored.pages.map((page) => page.id)).toEqual(['page-1', 'page-2'])
    expect(stored.pages[0].source).toBeInstanceOf(Blob)
    expect(stored.pages[0].thumbnail).toBeInstanceOf(Blob)

    const { whiteningStrength: _legacyMissingField, ...legacyAdjustments } = DEFAULT_ADJUSTMENTS
    await db.pages.update('page-1', { adjustments: legacyAdjustments as EnhancementSettings })
    const migrated = await getProjectWithPages(project.id)
    expect(migrated.pages[0].adjustments.whiteningStrength).toBe(DEFAULT_WHITENING_STRENGTH)

    const sourceRead = vi.spyOn(firstPage.source, 'arrayBuffer')
    await updatePageMetadata({ ...firstPage, rotation: 90, updatedAt: now + 1 })
    expect(sourceRead).not.toHaveBeenCalled()
    const metadataUpdated = await getProjectWithPages(project.id)
    expect(metadataUpdated.pages[0].rotation).toBe(90)

    const nextThumbnail = new Blob(['new-thumbnail'], { type: 'image/jpeg' })
    await updatePageWithThumbnail({ ...firstPage, rotation: 90 }, nextThumbnail)
    expect(sourceRead).not.toHaveBeenCalled()
    const thumbnailUpdated = await getProjectWithPages(project.id)
    expect(await thumbnailUpdated.pages[0].thumbnail?.text()).toBe('new-thumbnail')

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
