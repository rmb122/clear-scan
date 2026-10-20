import {
  AlertTriangle,
  ChevronDown,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectionButton } from '@/components/ui/selection-button'
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
import { messages } from '@/lib/i18n'
import { useLocale } from '@/hooks/use-locale'

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
  useLocale()
  const effectGroups: EffectGroup[] = [
    {
      key: 'shadow',
      label: messages.lighting,
      options: [
        { value: 'none', label: messages.off },
        { value: 'deshadow', label: messages.deshadow },
        { value: 'balance', label: messages.balance },
      ],
    },
    {
      key: 'glare',
      label: messages.glare,
      options: [
        { value: 'none', label: messages.off },
        { value: 'deglare', label: messages.deglare },
      ],
    },
    {
      key: 'color',
      label: messages.colorStyle,
      options: [
        { value: 'original', label: messages.originalColor },
        { value: 'enhanced-color', label: messages.enhancedColor },
        { value: 'grayscale', label: messages.grayscale },
        { value: 'black-white', label: messages.blackWhite },
      ],
    },
    {
      key: 'detail',
      label: messages.detail,
      options: [
        { value: 'none', label: messages.natural },
        { value: 'sharpen', label: messages.sharpen },
      ],
    },
  ]
  const defaultAdjustments = adjustmentsEqual(adjustments, DEFAULT_ADJUSTMENTS)
  const glareRepairEnabled = effects.glare === 'deglare'
  const activePreset =
    defaultAdjustments && effectsEqual(effects, ORIGINAL_EFFECTS)
      ? 'original'
      : defaultAdjustments && effectsEqual(effects, SMART_EFFECTS)
        ? 'smart'
        : 'custom'
  const adjustmentRows: Array<{
    key: keyof EnhancementSettings
    label: string
    min: number
    max: number
  }> = [
    { key: 'brightness', label: messages.brightness, min: -40, max: 40 },
    { key: 'contrast', label: messages.contrast, min: -30, max: 40 },
    ...(effects.color === 'enhanced-color'
      ? [{ key: 'whiteningStrength' as const, label: messages.whitening, min: 0, max: 100 }]
      : []),
    ...(effects.shadow !== 'none'
      ? [
          {
            key: 'shadowStrength' as const,
            label:
              effects.shadow === 'balance' ? messages.balanceStrength : messages.shadowStrength,
            min: 0,
            max: 100,
          },
        ]
      : []),
    ...(effects.detail === 'sharpen'
      ? [{ key: 'sharpness' as const, label: messages.sharpness, min: 0, max: 100 }]
      : []),
  ]

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
                  ? messages.glareSevereEnabled
                  : messages.glareSevereDisabled
                : glareRepairEnabled
                  ? messages.glareMildEnabled
                  : messages.glareMildDisabled}
            </span>
          </div>
        </div>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <Sparkles className="size-4 text-primary" />
            {messages.presets}
          </h3>
          <Badge variant="secondary">
            {activePreset === 'custom' ? messages.customEffects : messages.recommendedPreset}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {[
            {
              value: 'original' as const,
              label: messages.originalPreset,
            },
            {
              value: 'smart' as const,
              label: messages.smartPreset,
            },
          ].map((preset) => (
            <SelectionButton
              key={preset.value}
              aria-label={preset.label}
              selected={activePreset === preset.value}
              onClick={() => onPresetApply(preset.value)}
            >
              {preset.label}
            </SelectionButton>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold">{messages.effectCombination}</h3>
          <span className="text-[10px] font-semibold text-muted-foreground">
            {messages.stackCategories}
          </span>
        </div>
        <div className="space-y-3">
          {effectGroups.map((group) => (
            <fieldset key={group.key} className="rounded-xl border border-border/50 p-3">
              <legend className="px-1 text-xs font-bold">{group.label}</legend>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                {group.options.map((option) => (
                  <SelectionButton
                    key={option.value}
                    aria-label={option.label}
                    selected={effects[group.key] === option.value}
                    onClick={() => onEffectChange(group.key, option.value)}
                    className={cn(
                      group.key === 'shadow' && option.value === 'none' && 'col-span-2',
                    )}
                  >
                    {option.label}
                  </SelectionButton>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </section>

      <details className="group relative overflow-hidden rounded-xl border border-border/50 bg-background">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-bold [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-primary" />
            {messages.advancedAdjustments}
          </span>
          <ChevronDown className="size-4 text-muted-foreground transition group-open:rotate-180" />
        </summary>
        {!defaultAdjustments && (
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-9 top-1.5 hidden h-8 rounded-lg px-2.5 text-[11px] text-muted-foreground group-open:inline-flex"
            onClick={() => onAdjustmentsChange({ ...DEFAULT_ADJUSTMENTS })}
          >
            <RotateCcw className="size-3.5" />
            {messages.restoreDefaults}
          </Button>
        )}
        <div className="border-t border-border/70 px-4 pb-4 pt-4">
          <div className="space-y-5">
            {adjustmentRows.map((row) => (
              <label
                key={row.key}
                className="grid grid-cols-[4rem_1fr_2.5rem] items-center gap-3 text-xs"
              >
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
        <Button
          aria-label={messages.rotateCounterclockwise}
          variant="outline"
          onClick={() => onRotate('counterclockwise')}
        >
          <RotateCcw />
          {messages.counterclockwise}
        </Button>
        <Button
          aria-label={messages.rotateClockwise}
          variant="outline"
          onClick={() => onRotate('clockwise')}
        >
          <RotateCw />
          {messages.clockwise}
        </Button>
      </div>
    </div>
  )
}
