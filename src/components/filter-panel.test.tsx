import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ADJUSTMENTS,
  ORIGINAL_EFFECTS,
  SMART_EFFECTS,
  type EnhancementEffects,
  type EnhancementSettings,
} from '@/lib/types'
import { FilterPanel } from './filter-panel'

afterEach(cleanup)

function StatefulFilterPanel() {
  const [effects, setEffects] = useState<EnhancementEffects>({ ...ORIGINAL_EFFECTS })
  const [adjustments, setAdjustments] = useState<EnhancementSettings>({ ...DEFAULT_ADJUSTMENTS })
  return (
    <FilterPanel
      effects={effects}
      adjustments={adjustments}
      glareLevel="none"
      advancedReady
      onEffectChange={(category, effect) => {
        setEffects((current) => ({ ...current, [category]: effect }) as EnhancementEffects)
      }}
      onPresetApply={(preset) => {
        setEffects({ ...(preset === 'original' ? ORIGINAL_EFFECTS : SMART_EFFECTS) })
        setAdjustments({ ...DEFAULT_ADJUSTMENTS })
      }}
      onAdjustmentsChange={setAdjustments}
      onRotate={vi.fn()}
    />
  )
}

describe('FilterPanel', () => {
  it('combines different categories and keeps each category mutually exclusive', () => {
    render(<StatefulFilterPanel />)

    const shadow = screen.getByRole('button', { name: '标准去阴影' })
    const enhancedColor = screen.getByRole('button', { name: '彩色增强' })
    const blackWhite = screen.getByRole('button', { name: '黑白' })
    const sharpen = screen.getByRole('button', { name: '加锐' })
    fireEvent.click(shadow)
    fireEvent.click(enhancedColor)
    fireEvent.click(sharpen)
    expect(shadow).toHaveAttribute('aria-pressed', 'true')
    expect(enhancedColor).toHaveAttribute('aria-pressed', 'true')
    expect(sharpen).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(blackWhite)
    expect(blackWhite).toHaveAttribute('aria-pressed', 'true')
    expect(enhancedColor).toHaveAttribute('aria-pressed', 'false')
    expect(shadow).toHaveAttribute('aria-pressed', 'true')
    expect(sharpen).toHaveAttribute('aria-pressed', 'true')
  })

  it('applies the original and smart shortcuts as exact combinations', () => {
    render(<StatefulFilterPanel />)
    const original = screen.getByRole('button', { name: '原版' })
    const smart = screen.getByRole('button', { name: '智能增强' })
    fireEvent.click(smart)
    expect(smart).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '标准去阴影' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '去反光' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '彩色增强' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '加锐' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(original)
    expect(original).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('当前没有附加效果')).toBeInTheDocument()
  })

  it('locks AI when unavailable and keeps advanced controls collapsed', () => {
    const onAdvancedRequired = vi.fn()
    render(
      <FilterPanel
        effects={SMART_EFFECTS}
        adjustments={DEFAULT_ADJUSTMENTS}
        glareLevel="severe"
        onEffectChange={vi.fn()}
        onPresetApply={vi.fn()}
        onAdjustmentsChange={vi.fn()}
        onRotate={vi.fn()}
        onAdvancedRequired={onAdvancedRequired}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'AI 去阴影' }))
    expect(onAdvancedRequired).toHaveBeenCalledOnce()
    expect(screen.getByText(/纯白区域的文字无法恢复/)).toBeInTheDocument()
    expect(screen.getByText('高级微调').closest('details')).not.toHaveAttribute('open')
  })
})
