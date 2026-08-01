import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ADJUSTMENTS } from '@/lib/types'
import { FilterPanel } from './filter-panel'

describe('FilterPanel', () => {
  it('exposes all scanner presets and allows switching filters', () => {
    const onFilterChange = vi.fn()
    const onAdvancedRequired = vi.fn()
    render(
      <FilterPanel
        filter="smart"
        adjustments={DEFAULT_ADJUSTMENTS}
        glareLevel="none"
        onFilterChange={onFilterChange}
        onAdjustmentsChange={vi.fn()}
        onRotate={vi.fn()}
        onAdvancedRequired={onAdvancedRequired}
      />,
    )
    expect(screen.getByText('智能增强')).toBeInTheDocument()
    expect(screen.getByText('去反光')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '去阴影' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'AI 去阴影' })).toBeInTheDocument()
    expect(screen.getByText('黑白')).toBeInTheDocument()
    fireEvent.click(screen.getByText('黑白'))
    expect(onFilterChange).toHaveBeenCalledWith('black-white')
    fireEvent.click(screen.getByRole('button', { name: 'AI 去阴影' }))
    expect(onAdvancedRequired).toHaveBeenCalledOnce()
  })

  it('warns when highlights are severely clipped', () => {
    render(
      <FilterPanel
        filter="smart"
        adjustments={DEFAULT_ADJUSTMENTS}
        glareLevel="severe"
        onFilterChange={vi.fn()}
        onAdjustmentsChange={vi.fn()}
        onRotate={vi.fn()}
      />,
    )
    expect(screen.getByText(/纯白区域的文字无法恢复/)).toBeInTheDocument()
  })
})
