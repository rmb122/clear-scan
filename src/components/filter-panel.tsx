import { AlertTriangle, Check, ChevronDown, RotateCcw, RotateCw, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  DEFAULT_ADJUSTMENTS,
  ORIGINAL_EFFECTS,
  SMART_EFFECTS,
  type EnhancementEffect,
  type EnhancementEffects,
  type EnhancementSettings,
  type GlareLevel,
} from '@/lib/types'
import { cn } from '@/lib/utils'

type EffectCategory = keyof EnhancementEffects
type QuickPreset = 'original' | 'smart'
type RotationDirection = 'counterclockwise' | 'clockwise'

interface EffectOption {
  value: EnhancementEffect
  label: string
}

interface EffectGroup {
  key: EffectCategory
  label: string
  options: EffectOption[]
}

const effectGroups: EffectGroup[] = [
  {
    key: 'shadow',
    label: '光照修复',
    options: [
      { value: 'none', label: '关闭' },
      { value: 'deshadow', label: '标准去阴影' },
      { value: 'balance', label: '亮度均衡' },
    ],
  },
  {
    key: 'glare',
    label: '反光修复',
    options: [
      { value: 'none', label: '关闭' },
      { value: 'deglare', label: '去反光' },
    ],
  },
  {
    key: 'color',
    label: '色彩风格',
    options: [
      { value: 'original', label: '原色' },
      { value: 'enhanced-color', label: '彩色增强' },
      { value: 'grayscale', label: '灰度' },
      { value: 'black-white', label: '黑白' },
    ],
  },
  {
    key: 'detail',
    label: '细节增强',
    options: [
      { value: 'none', label: '自然' },
      { value: 'sharpen', label: '加锐' },
    ],
  },
]

function effectsEqual(left: EnhancementEffects, right: EnhancementEffects) {
  return (
    left.shadow === right.shadow &&
    left.glare === right.glare &&
    left.color === right.color &&
    left.detail === right.detail
  )
}

function adjustmentsEqual(left: EnhancementSettings, right: EnhancementSettings) {
  return (
    left.brightness === right.brightness &&
    left.contrast === right.contrast &&
    left.sharpness === right.sharpness &&
    left.shadowStrength === right.shadowStrength &&
    left.whiteningStrength === right.whiteningStrength
  )
}

function activeEffectLabels(effects: EnhancementEffects) {
  const labels: string[] = []
  if (effects.shadow === 'deshadow') labels.push('标准去阴影')
  if (effects.shadow === 'balance') labels.push('亮度均衡')
  if (effects.glare === 'deglare') labels.push('去反光')
  if (effects.color === 'grayscale') labels.push('灰度')
  if (effects.color === 'black-white') labels.push('黑白')
  if (effects.color === 'enhanced-color') labels.push('彩色增强')
  if (effects.detail === 'sharpen') labels.push('加锐')
  return labels
}

function DeferredAdjustmentSlider({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])

  return (
    <>
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={[draft]}
        onValueChange={([nextValue]) => setDraft(nextValue)}
        onValueCommit={([nextValue]) => {
          setDraft(nextValue)
          if (nextValue !== value) onCommit(nextValue)
        }}
      />
      <span className="text-right tabular-nums text-muted-foreground">{draft}</span>
    </>
  )
}

export function FilterPanel({
  effects,
  adjustments,
  glareLevel,
  onEffectChange,
  onPresetApply,
  onAdjustmentsChange,
  onRotate,
}: {
  effects: EnhancementEffects
  adjustments: EnhancementSettings
  glareLevel: GlareLevel
  onEffectChange: (category: EffectCategory, effect: EnhancementEffect) => void
  onPresetApply: (preset: QuickPreset) => void
  onAdjustmentsChange: (settings: EnhancementSettings) => void
  onRotate: (direction: RotationDirection) => void
}) {
  const defaultAdjustments = adjustmentsEqual(adjustments, DEFAULT_ADJUSTMENTS)
  const glareRepairEnabled = effects.glare === 'deglare'
  const activePreset =
    defaultAdjustments && effectsEqual(effects, ORIGINAL_EFFECTS)
      ? 'original'
      : defaultAdjustments && effectsEqual(effects, SMART_EFFECTS)
        ? 'smart'
        : 'custom'
  const enabledLabels = activeEffectLabels(effects)
  const adjustmentRows: Array<{
    key: keyof EnhancementSettings
    label: string
    min: number
    max: number
  }> = [
    { key: 'brightness', label: '亮度', min: -40, max: 40 },
    { key: 'contrast', label: '对比度', min: -30, max: 40 },
    ...(effects.color === 'enhanced-color'
      ? [{ key: 'whiteningStrength' as const, label: '增白强度', min: 0, max: 100 }]
      : []),
    ...(effects.shadow !== 'none'
      ? [
          {
            key: 'shadowStrength' as const,
            label: effects.shadow === 'balance' ? '均衡强度' : '阴影强度',
            min: 0,
            max: 100,
          },
        ]
      : []),
    ...(effects.detail === 'sharpen' ? [{ key: 'sharpness' as const, label: '锐化强度', min: 0, max: 100 }] : []),
  ]

  const selectEffect = (category: EffectCategory, value: EnhancementEffect) => {
    onEffectChange(category, value)
  }

  return (
    <div className="space-y-5">
      {glareLevel !== 'none' && (
        <div
          role="status"
          className={cn(
            'rounded-2xl border p-3 text-xs leading-5',
            glareLevel === 'severe'
              ? 'border-amber-300 bg-amber-50 text-amber-900'
              : 'border-primary/20 bg-primary/5 text-foreground',
          )}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {glareLevel === 'severe'
                ? glareRepairEnabled
                  ? '已启用去反光，正在压制可识别的高光；纯白区域的文字无法恢复时请换个角度重拍。'
                  : '检测到明显过曝区域。建议启用去反光；纯白区域的文字无法恢复时请换个角度重拍。'
                : glareRepairEnabled
                  ? '已启用去反光，可与光照修复同时使用。'
                  : '检测到轻微反光，可以与光照修复同时启用。'}
            </span>
          </div>
        </div>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <Sparkles className="size-4 text-primary" />
            快捷方案
          </h3>
          <Badge variant="secondary">{activePreset === 'custom' ? '自定义组合' : '推荐方案'}</Badge>
        </div>
        <div className="grid gap-1.5 rounded-2xl bg-muted p-1.5">
          {[
            {
              value: 'original' as const,
              label: '原版',
              description: '清除全部效果',
            },
            {
              value: 'smart' as const,
              label: '智能增强',
              description: '均衡光照＋去反光＋清晰文字',
            },
          ].map((preset) => (
            <button
              key={preset.value}
              type="button"
              aria-label={preset.label}
              aria-pressed={activePreset === preset.value}
              onClick={() => onPresetApply(preset.value)}
              className={cn(
                'flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition',
                activePreset === preset.value
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                  : 'text-muted-foreground hover:bg-background/65',
              )}
            >
              <span className="flex shrink-0 items-center gap-1.5 text-xs font-bold">
                {activePreset === preset.value && <Check className="size-3.5 text-primary" />}
                {preset.label}
              </span>
              <span className="text-right text-[10px] leading-4">{preset.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold">效果组合</h3>
          <span className="text-[10px] font-semibold text-muted-foreground">跨分类可叠加</span>
        </div>
        <div className="mb-3 flex min-h-7 flex-wrap gap-1.5" aria-label="当前启用效果">
          {enabledLabels.length ? (
            enabledLabels.map((label) => (
              <Badge key={label} variant="secondary">
                {label}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">当前没有附加效果</span>
          )}
        </div>
        <div className="space-y-3">
          {effectGroups.map((group) => (
            <fieldset key={group.key} className="rounded-2xl border border-border/80 p-3">
              <legend className="px-1 text-xs font-bold">{group.label}</legend>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                {group.options.map((option) => {
                  const selected = effects[group.key] === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={selected}
                      onClick={() => selectEffect(group.key, option.value)}
                      className={cn(
                        'relative min-h-10 rounded-xl border px-2 py-2 text-xs font-semibold transition',
                        group.key === 'shadow' && option.value === 'none' && 'col-span-2',
                        selected
                          ? 'border-primary bg-primary/8 text-primary ring-1 ring-primary/15'
                          : 'border-transparent bg-muted/70 text-muted-foreground hover:border-primary/20 hover:text-foreground',
                      )}
                    >
                      <span className="inline-flex items-center justify-center gap-1 whitespace-nowrap">
                        {selected && <Check className="size-3.5" />}
                        {option.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </section>

      <details className="group overflow-hidden rounded-2xl border border-border/80 bg-background">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-bold [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-primary" />
            高级微调
          </span>
          <span className="flex items-center gap-2 text-[10px] font-semibold text-muted-foreground">
            松手后更新预览
            <ChevronDown className="size-4 transition group-open:rotate-180" />
          </span>
        </summary>
        <div className="border-t border-border/70 px-4 pb-4 pt-4">
          <div className="mb-4 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => onAdjustmentsChange({ ...DEFAULT_ADJUSTMENTS })}>
              重置微调
            </Button>
          </div>
          <div className="space-y-5">
            {adjustmentRows.map((row) => (
              <label key={row.key} className="grid grid-cols-[4rem_1fr_2.5rem] items-center gap-3 text-xs">
                <span className="font-semibold text-muted-foreground">{row.label}</span>
                <DeferredAdjustmentSlider
                  label={row.label}
                  min={row.min}
                  max={row.max}
                  value={adjustments[row.key]}
                  onCommit={(value) => onAdjustmentsChange({ ...adjustments, [row.key]: value })}
                />
              </label>
            ))}
          </div>
        </div>
      </details>

      <div className="grid grid-cols-2 gap-2">
        <Button aria-label="逆时针旋转 90°" variant="outline" onClick={() => onRotate('counterclockwise')}>
          <RotateCcw />
          逆时针 90°
        </Button>
        <Button aria-label="顺时针旋转 90°" variant="outline" onClick={() => onRotate('clockwise')}>
          <RotateCw />
          顺时针 90°
        </Button>
      </div>
    </div>
  )
}
