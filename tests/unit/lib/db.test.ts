// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bulkPutPages,
  clearScannerData,
  db,
  deleteProject,
  getProjectPageSummary,
  getProjectPages,
  getProjectWithPages,
  updatePageMetadata,
  updatePageWithThumbnail,
  updateProjectSettings,
} from '@/lib/db'
import { makePage, makeProject } from '../../support/scan-fixtures'
import {
  holdNextPageWrite,
  holdNextProjectWrite,
  holdThumbnailEncoding,
} from '../../support/persistence'
import { DEFAULT_ADJUSTMENTS, DEFAULT_WATERMARK, SMART_EFFECTS } from '@/lib/types'

afterEach(async () => {
  vi.restoreAllMocks()
  await clearScannerData()
})

describe('local scan repository', () => {
  describe('project reads during queued writes', () => {
    it('waits for the latest watermark without losing other project settings', async () => {
      await db.projects.put(makeProject())
      const gate = holdNextProjectWrite()
      const watermark = { ...DEFAULT_WATERMARK, enabled: true, text: '仅供申请使用' }
      const first = updateProjectSettings('project-1', { watermark })
      const reading = getProjectWithPages('project-1')
      const received = vi.fn()
      void reading.then(received)
      const later: Promise<unknown>[] = []
      try {
        await vi.waitFor(() => expect(gate.writes).toHaveBeenCalled())
        expect(received).not.toHaveBeenCalled()
        later.push(
          updateProjectSettings('project-1', { name: '重命名文档', passportLayout: 'spread' }),
        )
        later.push(
          updateProjectSettings('project-1', { watermark: { ...watermark, text: '仅供审核使用' } }),
        )
        gate.release()
        expect((await reading).project).toMatchObject({
          name: '重命名文档',
          passportLayout: 'spread',
          watermark: { ...watermark, text: '仅供审核使用' },
        })
      } finally {
        gate.release()
        await Promise.allSettled([first, reading, ...later])
      }
    })

    it.each(['pages', 'project'] as const)(
      'loads current %s metadata without waiting for thumbnail encoding',
      async (kind) => {
        const firstPage = makePage()
        const secondPage = makePage({ id: 'page-2', order: 1 })
        await db.projects.put(makeProject())
        await bulkPutPages([firstPage, secondPage])
        const firstGate = holdThumbnailEncoding()
        const secondGate = holdThumbnailEncoding()
        const first = updatePageWithThumbnail(firstPage, firstGate.blob)
        const edited = updatePageMetadata({ ...firstPage, rotation: 90 })
        const second = updatePageWithThumbnail({ ...secondPage, rotation: 180 }, secondGate.blob)
        const reading =
          kind === 'pages'
            ? getProjectPages(firstPage.projectId)
            : getProjectWithPages(firstPage.projectId).then(({ pages }) => pages)
        try {
          await vi.waitFor(() => expect(secondGate.encoding).toHaveBeenCalled())
          const pages = await reading
          expect(pages.map((page) => page.rotation)).toEqual([90, 180])
          expect(pages.every((page) => page.thumbnail === undefined)).toBe(true)
        } finally {
          firstGate.release()
          secondGate.release()
          await Promise.allSettled([first, edited, second, reading])
        }
      },
    )

    it('includes edits appended after a project read has started waiting', async () => {
      const page = makePage()
      await db.projects.put(makeProject())
      await bulkPutPages([page])
      const gate = holdNextPageWrite()
      const first = updatePageMetadata({ ...page, rotation: 90 })
      const reading = getProjectWithPages(page.projectId)
      const received = vi.fn()
      void reading.then(received)
      let last: Promise<unknown> | undefined
      try {
        await vi.waitFor(() => expect(gate.writes).toHaveBeenCalled())
        expect(received).not.toHaveBeenCalled()
        last = updatePageMetadata({ ...page, rotation: 270 })
        gate.release()
        expect((await reading).pages[0].rotation).toBe(270)
      } finally {
        gate.release()
        await Promise.allSettled([first, last, reading])
      }
    })

    it('keeps other projects and display summaries available during a slow save', async () => {
      const page = makePage()
      const other = makePage({ id: 'other-page', projectId: 'other-project' })
      await db.projects.bulkPut([makeProject(), makeProject({ id: other.projectId })])
      await bulkPutPages([page, other])
      const gate = holdThumbnailEncoding()
      const writing = updatePageWithThumbnail(page, gate.blob)
      const loaded = vi.fn()
      const reading = Promise.all([
        getProjectWithPages(other.projectId),
        getProjectPageSummary(page.projectId),
      ]).then((results) => {
        loaded()
        return results
      })
      try {
        await vi.waitFor(() => expect(loaded).toHaveBeenCalled())
        const [project, summary] = await reading
        expect(project.pages[0].id).toBe(other.id)
        expect(summary.pageCount).toBe(1)
      } finally {
        gate.release()
        await Promise.allSettled([writing, reading])
      }
    })

    it('still opens committed data after a pending write fails', async () => {
      const page = makePage()
      await db.projects.put(makeProject())
      await bulkPutPages([page])
      const gate = holdThumbnailEncoding()
      vi.spyOn(db.pages, 'update').mockRejectedValueOnce(new Error('write failed'))
      const writing = updatePageWithThumbnail({ ...page, rotation: 90 }, gate.blob)
      const rejected = expect(writing).rejects.toThrow('write failed')
      const reading = getProjectWithPages(page.projectId)
      gate.release()
      await rejected
      expect((await reading).pages[0].rotation).toBe(0)
    })

    it('does not return deleted pages after waiting for their queued writes', async () => {
      const page = makePage()
      await db.projects.put(makeProject())
      await bulkPutPages([page])
      const gate = holdNextPageWrite()
      const writing = updatePageMetadata(page)
      const reading = getProjectWithPages(page.projectId)
      try {
        await vi.waitFor(() => expect(gate.writes).toHaveBeenCalled())
        await deleteProject(page.projectId)
        gate.release()
        expect(await reading).toEqual({ project: undefined, pages: [] })
      } finally {
        gate.release()
        await Promise.allSettled([writing, reading])
      }
    })
  })

  describe.each(['page', 'project', 'all data'] as const)('deleting %s', (scope) => {
    it.each(['metadata', 'thumbnail'] as const)(
      'does not restore deleted images when %s writes finish later',
      async (kind) => {
        const page = makePage()
        const otherProject = makeProject({ id: 'other-project' })
        const otherPage = makePage({ id: 'other-page', projectId: otherProject.id })
        await db.projects.bulkPut([makeProject(), otherProject])
        await bulkPutPages([page, makePage({ id: 'page-2', order: 1 }), otherPage])

        const { release, writes } = holdNextPageWrite()
        const thumbnail = new Blob(['thumbnail'], { type: 'image/png' })
        const first =
          kind === 'metadata' ? updatePageMetadata(page) : updatePageWithThumbnail(page, thumbnail)
        const second = updatePageMetadata({ ...page, rotation: 90 })
        try {
          await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
          if (scope === 'page') await db.pages.delete(page.id)
          else if (scope === 'project') await deleteProject(page.projectId)
          else await clearScannerData()
        } finally {
          release()
          await Promise.all([first, second])
        }

        expect(await db.pages.get(page.id)).toBeUndefined()
        // A later cleanup or autosave must also be harmless after deletion.
        await updatePageMetadata(page)
        await updatePageWithThumbnail(page, thumbnail)
        expect(await db.pages.get(page.id)).toBeUndefined()
        const remaining =
          scope === 'page' ? ['other-page', 'page-2'] : scope === 'project' ? ['other-page'] : []
        expect(await db.pages.toCollection().primaryKeys()).toEqual(remaining)
        expect(await db.projects.count()).toBe(
          scope === 'all data' ? 0 : scope === 'project' ? 1 : 2,
        )
      },
    )
  })

  it('commits edits during thumbnail encoding and recovers after a failed metadata write', async () => {
    const page = makePage()
    await db.projects.put(makeProject())
    await bulkPutPages([page])
    const { blob, release, encoding } = holdThumbnailEncoding()
    const first = updatePageWithThumbnail(page, blob)
    const second = updatePageMetadata({ ...page, rotation: 90, updatedAt: 2 })
    try {
      await vi.waitFor(() => expect(encoding).toHaveBeenCalled())
      await second
      expect((await db.pages.get(page.id))?.rotation).toBe(90)
    } finally {
      release()
      await Promise.all([first, second])
    }

    const stored = await getProjectWithPages(page.projectId)
    expect(stored.pages[0].rotation).toBe(90)
    expect(await stored.pages[0].thumbnail?.text()).toBe('thumbnail')

    vi.spyOn(db.pages, 'update').mockRejectedValueOnce(new Error('temporary write failure'))
    const failed = updatePageMetadata({ ...page, rotation: 180 })
    const recovered = updatePageMetadata({ ...page, rotation: 270 })
    await expect(failed).rejects.toThrow('temporary write failure')
    await recovered
    expect((await getProjectWithPages(page.projectId)).pages[0].rotation).toBe(270)
  })

  it('keeps thumbnails in save order without delaying newer metadata', async () => {
    const page = makePage()
    await bulkPutPages([page])
    const gate = holdThumbnailEncoding()
    const first = updatePageWithThumbnail(page, gate.blob)
    const last = updatePageWithThumbnail({ ...page, rotation: 90 }, new Blob(['latest']))
    try {
      expect((await getProjectPages(page.projectId))[0].rotation).toBe(90)
    } finally {
      gate.release()
      await Promise.all([first, last])
    }
    const [stored] = await getProjectPages(page.projectId)
    expect(await stored.thumbnail?.text()).toBe('latest')
    expect(stored.rotation).toBe(90)
  })

  it('stores a project with its ordered pages and deletes them atomically', async () => {
    const project = makeProject()
    const firstPage = makePage({
      cornerSource: 'manual',
      cropConfirmed: false,
      effects: { ...SMART_EFFECTS, color: 'grayscale' },
      adjustments: { ...DEFAULT_ADJUSTMENTS, whiteningStrength: 40 },
      thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
    })
    await db.projects.put(project)
    await bulkPutPages([makePage({ id: 'page-2', order: 1 }), firstPage])
    const rawPage = await db.pages.get('page-1')
    expect(rawPage?.source.data.byteLength).toBeGreaterThan(0)
    expect(rawPage?.thumbnail?.data.byteLength).toBeGreaterThan(0)

    const stored = await getProjectWithPages(project.id)
    expect(stored.project?.name).toBe('测试文档')
    expect(stored.pages.map((page) => page.id)).toEqual(['page-1', 'page-2'])
    expect(stored.pages[0].source).toBeInstanceOf(Blob)
    expect(stored.pages[0].thumbnail).toBeInstanceOf(Blob)
    expect(stored.pages[0]).toMatchObject({
      cornerSource: 'manual',
      cropConfirmed: false,
      effects: firstPage.effects,
      adjustments: firstPage.adjustments,
    })

    const summary = await getProjectPageSummary(project.id)
    expect(summary.pageCount).toBe(2)
    expect(await summary.thumbnail?.text()).toBe('thumbnail')

    const sourceRead = vi.spyOn(firstPage.source, 'arrayBuffer')
    await updatePageMetadata({ ...firstPage, rotation: 90, updatedAt: firstPage.updatedAt + 1 })
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
    await db.projects.put(makeProject({ id: 'project-to-clear', name: '待清理文档' }))

    await clearScannerData()

    expect(await db.projects.count()).toBe(0)
    expect(await db.pages.count()).toBe(0)
    expect(db.tables.map((table) => table.name)).toEqual(['projects', 'pages'])
  })
})
