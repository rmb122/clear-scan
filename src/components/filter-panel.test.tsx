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
  const [effects, setEffects] = useState<EnhancementEffects>({
    ...ORIGINAL_EFFECTS,
  })
  const [adjustments, setAdjustments] = useState<EnhancementSettings>({
    ...DEFAULT_ADJUSTMENTS,
  })
  return (
    <FilterPanel
      effects={effects}
      adjustments={adjustments}
      glareLevel="none"
      onEffectChange={(category, effect) => {
        setEffects((current) => ({ ...current, [category]: effect }) as EnhancementEffects)
      }}
      onPresetApply={(preset) => {
        setEffects({
          ...(preset === 'original' ? ORIGINAL_EFFECTS : SMART_EFFECTS),
        })
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
    const balance = screen.getByRole('button', { name: '亮度均衡' })
    const enhancedColor = screen.getByRole('button', { name: '彩色增强' })
    const blackWhite = screen.getByRole('button', { name: '黑白' })
    const sharpen = screen.getByRole('button', { name: '加锐' })
    fireEvent.click(shadow)
    expect(shadow).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(balance)
    fireEvent.click(enhancedColor)
    fireEvent.click(sharpen)
    expect(shadow).toHaveAttribute('aria-pressed', 'false')
    expect(balance).toHaveAttribute('aria-pressed', 'true')
    expect(enhancedColor).toHaveAttribute('aria-pressed', 'true')
    expect(sharpen).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(blackWhite)
    expect(blackWhite).toHaveAttribute('aria-pressed', 'true')
    expect(enhancedColor).toHaveAttribute('aria-pressed', 'false')
    expect(balance).toHaveAttribute('aria-pressed', 'true')
    expect(sharpen).toHaveAttribute('aria-pressed', 'true')
  })

  it('applies the original and smart shortcuts as exact combinations', () => {
    render(<StatefulFilterPanel />)
    const original = screen.getByRole('button', { name: '原版' })
    const smart = screen.getByRole('button', { name: '智能增强' })
    fireEvent.click(smart)
    expect(smart).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '亮度均衡' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '标准去阴影' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '去反光' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '彩色增强' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '加锐' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(original)
    expect(original).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('当前没有附加效果')).toBeInTheDocument()
  })

  it('uses a matching strength label for each light correction', () => {
    render(<StatefulFilterPanel />)

    fireEvent.click(screen.getByRole('button', { name: '亮度均衡' }))
    expect(screen.getByText('均衡强度')).toBeInTheDocument()
    expect(screen.queryByText('阴影强度')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '标准去阴影' }))
    expect(screen.getByText('阴影强度')).toBeInTheDocument()
    expect(screen.queryByText('均衡强度')).not.toBeInTheDocument()
  })

  it('offers counterclockwise rotation before clockwise rotation', () => {
    const onRotate = vi.fn()
    render(
      <FilterPanel
        effects={ORIGINAL_EFFECTS}
        adjustments={DEFAULT_ADJUSTMENTS}
        glareLevel="none"
        onEffectChange={vi.fn()}
        onPresetApply={vi.fn()}
        onAdjustmentsChange={vi.fn()}
        onRotate={onRotate}
      />,
    )
    const counterclockwise = screen.getByRole('button', { name: '逆时针旋转 90°' })
    const clockwise = screen.getByRole('button', { name: '顺时针旋转 90°' })
    expect(counterclockwise.compareDocumentPosition(clockwise) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(counterclockwise)
    fireEvent.click(clockwise)
    expect(onRotate.mock.calls).toEqual([['counterclockwise'], ['clockwise']])
  })

  it('describes active glare repair and keeps fine-tuning controls collapsed', () => {
    render(
      <FilterPanel
        effects={SMART_EFFECTS}
        adjustments={DEFAULT_ADJUSTMENTS}
        glareLevel="severe"
        onEffectChange={vi.fn()}
        onPresetApply={vi.fn()}
        onAdjustmentsChange={vi.fn()}
        onRotate={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('已启用去反光')
    expect(screen.getByRole('status')).not.toHaveTextContent('建议启用去反光')
    expect(screen.getByText(/纯白区域的文字无法恢复/)).toBeInTheDocument()
    expect(screen.getByText('高级微调').closest('details')).not.toHaveAttribute('open')
  })

  it('recommends glare repair only while it is disabled', () => {
    render(
      <FilterPanel
        effects={ORIGINAL_EFFECTS}
        adjustments={DEFAULT_ADJUSTMENTS}
        glareLevel="severe"
        onEffectChange={vi.fn()}
        onPresetApply={vi.fn()}
        onAdjustmentsChange={vi.fn()}
        onRotate={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('建议启用去反光')
  })
})
