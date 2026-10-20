import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repository from '@/lib/db'
import { scannerClient } from '@/lib/scanner-client'
import { DEFAULT_QUAD } from '@/lib/geometry'
import { messages } from '@/lib/i18n'
import { formatDate } from '@/lib/utils'
import { ScannerNavigationContext } from '@/hooks/use-scanner-navigation'
import { makePage, makeProject } from '../support/scan-fixtures'
import { holdNextPageWrite } from '../support/persistence'
import { ScanPage } from '@/pages/scan-page'
import { HomePage } from '@/pages/home-page'
import { HistoryPage } from '@/pages/history-page'

vi.mock('@/components/crop-editor', () => ({ CropEditor: () => <div /> }))
vi.mock('@/lib/engine-cache', () => ({ hasCachedEngineAsset: async () => true }))
vi.mock('@/hooks/use-scan-preview', () => ({
  useScanPreview: () => ({
    preview: { url: 'blob:preview', blob: new Blob(['preview'], { type: 'image/jpeg' }) },
    isCurrent: true,
    rendering: false,
    clearPreview: vi.fn(),
  }),
}))

function renderScanner(route = '/project/project-1') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Link to="/scan/document">扫一扫</Link>
      <Link to="/project/project-2">另一个项目</Link>
      <Link to="/">首页</Link>
      <Link to="/history">扫描记录</Link>
      <ScannerNavigationContext.Provider value={() => undefined}>
        <Routes>
          <Route path="project/:projectId" element={<ScanPage />} />
          <Route path="scan/:mode" element={<ScanPage />} />
          <Route path="/" element={<HomePage />} />
          <Route path="history" element={<HistoryPage />} />
        </Routes>
      </ScannerNavigationContext.Provider>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  vi.spyOn(scannerClient, 'isReady', 'get').mockReturnValue(true)
  vi.spyOn(scannerClient, 'prewarm').mockResolvedValue()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
  await repository.db.projects.put(makeProject())
  await repository.putPage(makePage())
})

afterEach(async () => {
  cleanup()
  // Unmount persistence is asynchronous; let it finish before clearing the database.
  await vi.waitFor(async () => {
    await repository.db.projects.count()
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await repository.clearScannerData()
})

describe('scan page persistence', () => {
  it('keeps an invalid saved crop unconfirmed and asks the user to adjust it', async () => {
    await repository.putPage(
      makePage({
        cropConfirmed: false,
        corners: [DEFAULT_QUAD[0], DEFAULT_QUAD[2], DEFAULT_QUAD[1], DEFAULT_QUAD[3]],
      }),
    )
    const errorToast = vi.spyOn(toast, 'error')
    renderScanner()
    const confirm = await screen.findByRole('button', { name: '确认裁剪' })
    await waitFor(() => expect(confirm).toBeEnabled())
    fireEvent.click(confirm)

    expect(errorToast).toHaveBeenCalledWith(messages.invalidCropCorners)
    expect(screen.getByRole('heading', { name: '确认四个角点' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出' })).toBeDisabled()
    expect((await repository.getProjectPages('project-1'))[0].cropConfirmed).toBe(false)
  })

  it('shares watermark settings across existing and new pages and restores them on reopen', async () => {
    await repository.putPage(makePage({ id: 'page-2', order: 1 }))
    await repository.db.projects.put(makeProject({ id: 'project-2', name: '另一个项目' }))
    await repository.putPage(makePage({ id: 'other-page', projectId: 'project-2' }))
    const { unmount } = renderScanner()
    fireEvent.click(await screen.findByRole('button', { name: '水印' }))
    expect(screen.getByRole('textbox', { name: '水印文字' })).toHaveValue('仅供办理业务使用')
    fireEvent.click(screen.getByRole('switch', { name: '启用水印' }))
    await waitFor(async () => {
      expect((await repository.db.projects.get('project-1'))?.watermark).toMatchObject({
        enabled: true,
        text: '仅供办理业务使用',
      })
    })
    fireEvent.change(screen.getByRole('textbox', { name: '水印文字' }), {
      target: { value: '仅供审核使用' },
    })
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), {
      target: { value: '申请材料' },
    })
    fireEvent.click(screen.getByRole('button', { name: '打开第 2 页' }))
    fireEvent.click(screen.getByRole('button', { name: '水印' }))
    expect(screen.getByRole('textbox', { name: '水印文字' })).toHaveValue('仅供审核使用')
    unmount()

    await repository.putPage(makePage({ id: 'page-3', order: 2 }))
    renderScanner()
    await screen.findByDisplayValue('申请材料')
    fireEvent.click(screen.getByRole('button', { name: '打开第 3 页' }))
    fireEvent.click(screen.getByRole('button', { name: '水印' }))
    expect(screen.getByRole('textbox', { name: '水印文字' })).toHaveValue('仅供审核使用')
    expect(screen.getByRole('switch', { name: '启用水印' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    fireEvent.click(screen.getByRole('link', { name: '另一个项目' }))
    await screen.findByDisplayValue('另一个项目')
    fireEvent.click(screen.getByRole('button', { name: '水印' }))
    expect(screen.getByRole('textbox', { name: '水印文字' })).toHaveValue('仅供办理业务使用')
    expect(screen.getByRole('switch', { name: '启用水印' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('keeps edits and the new order when reordering finishes after further editing', async () => {
    await repository.putPage(makePage({ id: 'page-2', order: 1 }))
    renderScanner()
    await screen.findByRole('button', { name: '灰度' })
    const gate = holdNextPageWrite()
    try {
      fireEvent.click(screen.getByRole('button', { name: '第 1 页后移' }))
      await waitFor(() => expect(gate.writes).toHaveBeenCalled())
      fireEvent.click(screen.getByRole('button', { name: '灰度' }))
      fireEvent.click(screen.getByRole('button', { name: '顺时针旋转 90°' }))
    } finally {
      await act(async () => gate.release())
    }

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '打开第 2 页' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(screen.getByRole('button', { name: '灰度' })).toHaveAttribute('aria-pressed', 'true')
    expect((await repository.getProjectPages('project-1'))[1]).toMatchObject({
      id: 'page-1',
      order: 1,
      rotation: 90,
      effects: { color: 'grayscale' },
    })
  })

  it('does not restore old pages when reordering finishes after navigation', async () => {
    await repository.putPage(makePage({ id: 'page-2', order: 1 }))
    renderScanner()
    await screen.findByRole('button', { name: '灰度' })
    const gate = holdNextPageWrite()
    try {
      fireEvent.click(screen.getByRole('button', { name: '第 1 页后移' }))
      await waitFor(() => expect(gate.writes).toHaveBeenCalled())
      fireEvent.click(screen.getByRole('link', { name: '扫一扫' }))
      await screen.findByRole('heading', { name: '添加文档页面' })
    } finally {
      await act(async () => gate.release())
    }
    await act(async () => {
      await repository.getProjectPages('project-1')
    })
    expect(screen.queryByRole('button', { name: '打开第 1 页' })).not.toBeInTheDocument()
    expect((await repository.getProjectPages('project-1')).map((page) => page.id)).toEqual([
      'page-2',
      'page-1',
    ])
  })

  it.each(['首页', '扫描记录'])(
    'keeps edits when reopening from %s before the previous component finishes saving',
    async (destination) => {
      const { release } = holdNextPageWrite()
      const metadata = vi.spyOn(repository, 'updatePageMetadata')
      const reads = vi.spyOn(repository, 'getProjectWithPages')
      renderScanner()
      try {
        fireEvent.click(await screen.findByRole('button', { name: '保存页面' }))
        fireEvent.click(screen.getByRole('button', { name: '灰度' }))
        fireEvent.click(screen.getByRole('link', { name: destination }))
        const card = await screen.findByRole('article')
        fireEvent.click(within(card).getByRole('link', { name: /测试文档/ }))
        await waitFor(() => expect(reads).toHaveBeenCalledTimes(2))
        // Let a database read and React effects complete while the old save is held.
        await act(async () => {
          await repository.db.pages.count()
        })
        expect(screen.getByRole('status')).toHaveTextContent('正在打开扫描项目')
        expect(screen.queryByRole('button', { name: '灰度' })).not.toBeInTheDocument()
      } finally {
        await act(async () => {
          release()
        })
      }

      await waitFor(() =>
        expect(screen.getByRole('button', { name: '灰度' })).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      )
      await waitFor(() => expect(metadata).toHaveBeenCalledTimes(2), { timeout: 2000 })
      await waitFor(async () => {
        expect((await repository.db.pages.get('page-1'))?.effects?.color).toBe('grayscale')
      })
    },
  )

  it.each(['首页', '扫描记录'])(
    'shows the edited project first on %s while the page flush is still pending',
    async (destination) => {
      const recent = Date.now() - 60_000
      await repository.db.projects.bulkPut(
        Array.from({ length: 4 }, (_, index) =>
          makeProject({
            id: `project-${index + 2}`,
            name: `其他项目 ${index + 2}`,
            updatedAt: recent - index * 1000,
          }),
        ),
      )
      const { release } = holdNextPageWrite()
      renderScanner()
      try {
        fireEvent.click(await screen.findByRole('button', { name: '黑白' }))
        fireEvent.click(screen.getByRole('link', { name: destination }))

        const cards = await screen.findAllByRole('article')
        expect(cards).toHaveLength(destination === '首页' ? 4 : 5)
        expect(within(cards[0]).getByRole('heading', { name: '测试文档' })).toBeInTheDocument()
        const project = (await repository.db.projects.get('project-1'))!
        expect(project.updatedAt).toBeGreaterThan(recent)
        expect(within(cards[0]).getByText(formatDate(project.updatedAt))).toBeInTheDocument()
        expect((await repository.db.pages.get('page-1'))?.effects?.color).toBe('enhanced-color')
      } finally {
        await act(async () => {
          release()
        })
      }
      await waitFor(async () => {
        expect((await repository.db.pages.get('page-1'))?.effects?.color).toBe('black-white')
      })
    },
  )

  it('keeps a deleted page absent after its pending save completes', async () => {
    const { release } = holdNextPageWrite()
    const savedToast = vi.spyOn(toast, 'success')
    renderScanner()
    try {
      fireEvent.click(await screen.findByRole('button', { name: '保存页面' }))
      fireEvent.click(screen.getByRole('button', { name: '删除第 1 页' }))
      fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
      await screen.findByRole('heading', { name: '添加文档页面' })
    } finally {
      await act(async () => {
        release()
      })
    }
    await waitFor(() => expect(savedToast).toHaveBeenCalledWith('页面已保存到本地'))
    expect(await repository.db.pages.count()).toBe(0)
    expect(screen.queryByRole('button', { name: '打开第 1 页' })).not.toBeInTheDocument()
  })

  it('flushes edits when a reused scan route resets the current project', async () => {
    renderScanner()
    await screen.findByRole('button', { name: '黑白' })

    fireEvent.click(screen.getByRole('button', { name: '黑白' }))
    fireEvent.click(screen.getByRole('link', { name: '扫一扫' }))

    await screen.findByRole('heading', { name: '添加文档页面' })
    await waitFor(async () => {
      expect((await repository.getProjectPages('project-1'))[0].effects.color).toBe('black-white')
    })
  })

  it('flushes the previous project before loading another project in the same component', async () => {
    await repository.db.projects.put(makeProject({ id: 'project-2', name: '第二个项目' }))
    await repository.putPage(makePage({ id: 'page-2', projectId: 'project-2' }))
    renderScanner()
    await screen.findByRole('button', { name: '黑白' })

    fireEvent.click(screen.getByRole('button', { name: '黑白' }))
    fireEvent.click(screen.getByRole('link', { name: '另一个项目' }))

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '项目名称' })).toHaveValue('第二个项目'),
    )
    await waitFor(async () => {
      expect((await repository.getProjectPages('project-1'))[0].effects.color).toBe('black-white')
    })
    expect((await repository.getProjectPages('project-2'))[0].effects.color).toBe('enhanced-color')
  })

  it('keeps edits made during a pending save and subsequently autosaves them', async () => {
    const { release } = holdNextPageWrite()
    const savedToast = vi.spyOn(toast, 'success')
    renderScanner()
    await screen.findByRole('button', { name: '保存页面' })

    fireEvent.click(screen.getByRole('button', { name: '保存页面' }))
    fireEvent.click(screen.getByRole('button', { name: '顺时针旋转 90°' }))
    fireEvent.click(screen.getByRole('button', { name: '灰度' }))
    await act(async () => {
      release()
    })

    await waitFor(() => expect(savedToast).toHaveBeenCalledWith('页面已保存到本地'))
    expect(screen.getByRole('button', { name: '灰度' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(
      async () => {
        const [stored] = await repository.getProjectPages('project-1')
        expect(stored.rotation).toBe(90)
        expect(stored.effects.color).toBe('grayscale')
      },
      { timeout: 2000 },
    )
  })

  it('submits newer edits immediately while a manual metadata write is pending', async () => {
    const { release } = holdNextPageWrite()
    const metadata = vi.spyOn(repository, 'updatePageMetadata')
    const savedToast = vi.spyOn(toast, 'success')
    renderScanner()
    await screen.findByRole('button', { name: '保存页面' })

    fireEvent.click(screen.getByRole('button', { name: '保存页面' }))
    fireEvent.click(screen.getByRole('button', { name: '顺时针旋转 90°' }))
    await waitFor(
      () => expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ rotation: 90 })),
      { timeout: 2000 },
    )
    await act(async () => {
      release()
    })

    await waitFor(() => expect(savedToast).toHaveBeenCalledWith('页面已保存到本地'))
    await waitFor(async () => {
      expect((await repository.getProjectPages('project-1'))[0].rotation).toBe(90)
    })
  })

  it('does not restore old pages after navigation while a save is pending', async () => {
    const { release } = holdNextPageWrite()
    const savedToast = vi.spyOn(toast, 'success')
    renderScanner()
    await screen.findByRole('button', { name: '保存页面' })

    fireEvent.click(screen.getByRole('button', { name: '保存页面' }))
    fireEvent.click(screen.getByRole('button', { name: '黑白' }))
    fireEvent.click(screen.getByRole('link', { name: '扫一扫' }))
    await screen.findByRole('heading', { name: '添加文档页面' })
    await act(async () => {
      release()
    })

    await waitFor(() => expect(savedToast).toHaveBeenCalledWith('页面已保存到本地'))
    expect(screen.queryByRole('button', { name: '打开第 1 页' })).not.toBeInTheDocument()
    await waitFor(async () => {
      expect((await repository.getProjectPages('project-1'))[0].effects.color).toBe('black-white')
    })
  })

  it('keeps an ID card in the editor if it changes while saving', async () => {
    await repository.db.projects.put(makeProject({ mode: 'id-card' }))
    await repository.putPage(makePage({ role: 'front' }))
    const { release } = holdNextPageWrite()
    const savedToast = vi.spyOn(toast, 'success')
    renderScanner()
    await screen.findByRole('button', { name: '保存页面' })

    fireEvent.click(screen.getByRole('button', { name: '保存页面' }))
    fireEvent.click(screen.getByRole('button', { name: '顺时针旋转 90°' }))
    await act(async () => {
      release()
    })

    await waitFor(() => expect(savedToast).toHaveBeenCalledWith('页面已保存到本地'))
    expect(screen.getByRole('heading', { name: '调整扫描效果' })).toBeInTheDocument()
  })
})

describe('scan engine recovery', () => {
  it('resets loading when retrying an engine that has already become ready', async () => {
    const ready = vi.spyOn(scannerClient, 'isReady', 'get').mockReturnValue(false)
    vi.spyOn(scannerClient, 'prewarm').mockRejectedValueOnce(new Error('temporary failure'))
    renderScanner()
    await screen.findByRole('button', { name: '重新加载' })

    ready.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    fireEvent.click(screen.getByRole('button', { name: '调整边缘' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '确认裁剪' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '重新识别' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(scannerClient.prewarm).toHaveBeenCalledTimes(1)
  })

  it.each(['upload', 'redetect'] as const)(
    'clears the old error when %s recovers the engine',
    async (operation) => {
      const ready = vi.spyOn(scannerClient, 'isReady', 'get').mockReturnValue(false)
      vi.spyOn(scannerClient, 'prewarm').mockRejectedValueOnce(new Error('temporary failure'))
      const sample = makePage()
      vi.spyOn(scannerClient, 'detect').mockImplementation(async () => {
        ready.mockReturnValue(true)
        return {
          width: sample.width,
          height: sample.height,
          corners: sample.corners,
          confidence: sample.confidence,
          cornerSource: sample.cornerSource,
          glareLevel: sample.glareLevel,
        }
      })
      const { container } = renderScanner(operation === 'upload' ? '/scan/document' : undefined)
      await screen.findByRole('button', { name: '重新加载' })

      if (operation === 'upload') {
        fireEvent.change(container.querySelectorAll('input[type="file"]')[1], {
          target: { files: [new File(['source'], 'recovery.png', { type: 'image/png' })] },
        })
      } else {
        fireEvent.click(await screen.findByRole('button', { name: '调整边缘' }))
        fireEvent.click(screen.getByRole('button', { name: '重新识别' }))
      }

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
      expect(screen.getByRole('button', { name: '确认裁剪' })).toBeEnabled()
      expect(screen.getByRole('button', { name: '重新识别' })).toBeEnabled()
    },
  )
})
