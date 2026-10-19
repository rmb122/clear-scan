import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scannerClient } from '@/lib/scanner-client'
import { useScanPreview } from '@/hooks/use-scan-preview'
import { DEFAULT_WATERMARK } from '@/lib/types'
import { makePage } from '../../support/scan-fixtures'

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

    rerender({ page: { ...firstPage, adjustments: { ...firstPage.adjustments, brightness: 12 } } })
    expect(result.current.isCurrent).toBe(false)
    await waitFor(() => expect(result.current.preview?.url).toBe('blob:preview-2'))
    expect(revokeUrl).toHaveBeenCalledWith('blob:preview-1')

    unmount()
    expect(createUrl).toHaveBeenCalledTimes(2)
    expect(revokeUrl).toHaveBeenCalledWith('blob:preview-2')
  })

  it('aborts an obsolete project watermark render and clears previews when the page changes', async () => {
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
    const watermark = { ...DEFAULT_WATERMARK, enabled: true, text: '仅供申请使用' }
    const { result, rerender } = renderHook(
      ({ page, enabled, watermark }) => useScanPreview(page, enabled, watermark),
      {
        initialProps: { page: firstPage, enabled: true, watermark },
      },
    )

    await waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    const signal = render.mock.calls[0][2]?.signal
    rerender({
      page: firstPage,
      enabled: true,
      watermark: { ...watermark, text: '仅供审核使用' },
    })
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

    rerender({ page: makePage({ id: 'page-2' }), enabled: false, watermark })
    expect(result.current.preview).toBeUndefined()
    expect(revokeUrl).toHaveBeenCalledWith('blob:preview')
  })

  it('offers a retry when preview generation fails', async () => {
    const render = vi
      .spyOn(scannerClient, 'render')
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ blob: new Blob(['preview']), width: 100, height: 80 })
    const toastError = vi.spyOn(toast, 'error')
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const { result } = renderHook(() => useScanPreview(makePage(), true))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('预览生成失败', expect.anything()))
    const options = toastError.mock.calls[0][1] as { action?: { onClick: () => void } }

    act(() => options.action?.onClick())

    await waitFor(() => expect(result.current.preview?.url).toBe('blob:preview'))
    expect(render).toHaveBeenCalledTimes(2)
  })
})
