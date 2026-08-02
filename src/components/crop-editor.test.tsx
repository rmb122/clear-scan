import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_QUAD } from '@/lib/geometry'
import type { NormalizedQuad } from '@/lib/types'
import { CropEditor } from './crop-editor'

function editorRect(width = 1000, height = 500) {
  return {
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

function renderEditor(corners: NormalizedQuad, onChange = vi.fn()) {
  const result = render(
    <CropEditor
      sourceUrl="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
      width={1000}
      height={500}
      corners={corners}
      cornerSource="detected"
      onChange={onChange}
    />,
  )
  const surface = screen.getByRole('img', { name: '待裁剪文档' }).parentElement as HTMLDivElement
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(editorRect())
  return { ...result, onChange }
}

describe('CropEditor', () => {
  const frames: FrameRequestCallback[] = []

  beforeEach(() => {
    frames.length = 0
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback)
        return frames.length
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('updates the local crop overlay per frame and commits only once on release', () => {
    const onChange = vi.fn()
    renderEditor(DEFAULT_QUAD, onChange)
    const handle = screen.getByRole('button', { name: '拖动第 1 个裁剪点' })
    Object.defineProperty(handle, 'setPointerCapture', { configurable: true, value: vi.fn() })

    fireEvent.pointerDown(handle, { pointerId: 7 })
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 300, clientY: 200 })
    expect(onChange).not.toHaveBeenCalled()

    act(() => frames[0](16))
    expect(handle).toHaveStyle({ left: '30%', top: '40%' })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 900, clientY: 490 })
    fireEvent.pointerUp(handle, { pointerId: 7 })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0][0]).toEqual({ x: 0.9, y: 0.98 })
  })

  it('clamps the final point and commits an interrupted drag once', () => {
    const onChange = vi.fn()
    renderEditor(DEFAULT_QUAD, onChange)
    const handle = screen.getByRole('button', { name: '拖动第 4 个裁剪点' })
    Object.defineProperty(handle, 'setPointerCapture', { configurable: true, value: vi.fn() })

    fireEvent.pointerDown(handle, { pointerId: 3 })
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: -100, clientY: 900 })
    fireEvent.pointerCancel(handle, { pointerId: 3 })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0][3]).toEqual({ x: 0.005, y: 0.995 })
  })

  it('syncs externally replaced corners while idle', () => {
    const onChange = vi.fn()
    const { rerender } = renderEditor(DEFAULT_QUAD, onChange)
    const next = DEFAULT_QUAD.map((point) => ({ ...point })) as NormalizedQuad
    next[0] = { x: 0.2, y: 0.25 }

    rerender(
      <CropEditor
        sourceUrl="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
        width={1000}
        height={500}
        corners={next}
        cornerSource="manual"
        onChange={onChange}
      />,
    )

    expect(screen.getByRole('button', { name: '拖动第 1 个裁剪点' })).toHaveStyle({ left: '20%', top: '25%' })
  })
})
