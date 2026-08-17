import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_QUAD } from '@/lib/geometry'
import { scannerClient } from '@/lib/scanner-client'
import { DEFAULT_ADJUSTMENTS, SMART_EFFECTS, type ScanPage } from '@/lib/types'
import { useScanPreview } from './use-scan-preview'

function makePage(id = 'page-1', brightness = 0): ScanPage {
  return {
    id,
    projectId: 'project-1',
    order: 0,
    role: 'page',
    source: new Blob(['source'], { type: 'image/jpeg' }),
    sourceName: `${id}.jpg`,
    width: 1200,
    height: 900,
    corners: DEFAULT_QUAD,
    confidence: 0.9,
    cornerSource: 'detected',
    cropConfirmed: true,
    glareLevel: 'none',
    rotation: 0,
    effects: { ...SMART_EFFECTS },
    adjustments: { ...DEFAULT_ADJUSTMENTS, brightness },
    createdAt: 1,
    updatedAt: 1,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useScanPreview', () => {
  it('renders after the debounce and releases replaced preview URLs', async () => {
    const render = vi
      .spyOn(scannerClient, 'render')
      .mockResolvedValue({ blob: new Blob(['preview']), width: 100, height: 80 })
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:preview-1')
      .mockReturnValueOnce('blob:preview-2')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const firstPage = makePage()
    const { result, rerender, unmount } = renderHook(({ page }) => useScanPreview(page, true), {
      initialProps: { page: firstPage },
    })

    await waitFor(() => expect(result.current.preview?.url).toBe('blob:preview-1'))
    expect(result.current.isCurrent).toBe(true)
    expect(render).toHaveBeenCalledTimes(1)

    rerender({ page: makePage('page-1', 12) })
    expect(result.current.isCurrent).toBe(false)
    await waitFor(() => expect(result.current.preview?.url).toBe('blob:preview-2'))
    expect(revokeUrl).toHaveBeenCalledWith('blob:preview-1')

    unmount()
    expect(createUrl).toHaveBeenCalledTimes(2)
    expect(revokeUrl).toHaveBeenCalledWith('blob:preview-2')
  })

  it('aborts an obsolete render and clears previews when the page changes', async () => {
    const resolveRender: Array<(value: { blob: Blob; width: number; height: number }) => void> = []
    const render = vi.spyOn(scannerClient, 'render').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRender.push(resolve)
        }),
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const firstPage = makePage()
    const { result, rerender } = renderHook(({ page, enabled }) => useScanPreview(page, enabled), {
      initialProps: { page: firstPage, enabled: true },
    })

    await waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    const signal = render.mock.calls[0][2]?.signal
    rerender({ page: makePage('page-1', 10), enabled: true })
    expect(signal?.aborted).toBe(true)
    await waitFor(() => expect(render).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolveRender[0]({ blob: new Blob(['stale']), width: 100, height: 80 })
    })
    expect(result.current.preview).toBeUndefined()

    await act(async () => {
      resolveRender[1]({ blob: new Blob(['current']), width: 100, height: 80 })
    })
    expect(result.current.preview?.url).toBe('blob:preview')

    rerender({ page: makePage('page-2'), enabled: false })
    expect(result.current.preview).toBeUndefined()
    expect(revokeUrl).toHaveBeenCalledWith('blob:preview')
  })
})
