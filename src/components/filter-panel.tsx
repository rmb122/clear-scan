import { AlertTriangle, LockKeyhole, RotateCw, SlidersHorizontal, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { DEFAULT_ADJUSTMENTS, FILTER_LABELS, type EnhancementSettings, type FilterPreset, type GlareLevel } from '@/lib/types'
import { cn } from '@/lib/utils'

const filters: Array<{ value: FilterPreset; swatch: string }> = [
  { value: 'original', swatch: 'bg-gradient-to-br from-sky-100 via-white to-amber-100' },
  { value: 'smart', swatch: 'bg-gradient-to-br from-emerald-100 via-white to-sky-100 contrast-125' },
  { value: 'deshadow', swatch: 'bg-[linear-gradient(120deg,#94a3b8_0%,#f8fafc_52%,#fff_100%)]' },
  { value: 'ai-deshadow', swatch: 'bg-[radial-gradient(circle_at_30%_70%,#d1fae5_0%,#fff_58%,#cffafe_100%)]' },
  { value: 'deglare', swatch: 'bg-gradient-to-br from-slate-100 via-white to-slate-200' },
  { value: 'grayscale', swatch: 'bg-gradient-to-br from-zinc-200 via-white to-zinc-500 grayscale' },
  { value: 'black-white', swatch: 'bg-[linear-gradient(135deg,#fff_48%,#1f2937_49%)]' },
  { value: 'sharpen', swatch: 'bg-gradient-to-br from-blue-100 via-white to-orange-100 contrast-150' },
  { value: 'vivid', swatch: 'bg-gradient-to-br from-pink-300 via-yellow-200 to-cyan-300 saturate-150' },
]

export function FilterPanel({
  filter,
  adjustments,
  glareLevel,
  onFilterChange,
  onAdjustmentsChange,
  onRotate,
  advancedReady = false,
  onAdvancedRequired,
}: {
  filter: FilterPreset
  adjustments: EnhancementSettings
  glareLevel: GlareLevel
  onFilterChange: (filter: FilterPreset) => void
  onAdjustmentsChange: (settings: EnhancementSettings) => void
  onRotate: () => void
  advancedReady?: boolean
  onAdvancedRequired?: () => void
}) {
  const adjustmentRows: Array<{ key: keyof EnhancementSettings; label: string; min: number; max: number }> = [
    { key: 'brightness', label: '亮度', min: -40, max: 40 },
    { key: 'contrast', label: '对比度', min: -30, max: 40 },
    { key: 'sharpness', label: '锐度', min: 0, max: 100 },
    { key: 'shadowStrength', label: '去阴影', min: 0, max: 100 },
  ]

  return (
    <div className="space-y-6">
      {glareLevel !== 'none' && (
        <div className={cn('rounded-2xl border p-3 text-xs leading-5', glareLevel === 'severe' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-primary/20 bg-primary/5 text-foreground')}>
          <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{glareLevel === 'severe' ? '检测到明显过曝区域。去反光可以压低高光，但纯白区域的文字无法恢复，建议换个角度重拍。' : '检测到轻微反光，智能增强会自动进行抑制。'}</span></div>
        </div>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-bold"><Sparkles className="size-4 text-primary" />效果</h3><Badge variant="secondary">非破坏编辑</Badge></div>
        <div className="grid grid-cols-4 gap-2 lg:grid-cols-3 xl:grid-cols-4">
          {filters.map((item) => {
            const locked = item.value === 'ai-deshadow' && !advancedReady
            return <button key={item.value} type="button" onClick={() => locked ? onAdvancedRequired?.() : onFilterChange(item.value)} className={cn('relative rounded-xl border p-1 text-center transition hover:border-primary/30', filter === item.value ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-border bg-background')}><span className={cn('block aspect-[4/3] rounded-lg border border-black/5', item.swatch, locked && 'opacity-55')} />{locked && <span className="absolute right-2 top-2 grid size-5 place-items-center rounded-full bg-black/65 text-white"><LockKeyhole className="size-2.5" /></span>}<span className="mt-1.5 block text-[10px] font-semibold">{FILTER_LABELS[item.value]}</span></button>
          })}
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-bold"><SlidersHorizontal className="size-4 text-primary" />微调</h3><Button variant="ghost" size="sm" onClick={() => onAdjustmentsChange({ ...DEFAULT_ADJUSTMENTS })}>重置</Button></div>
        <div className="space-y-5">{adjustmentRows.map((row) => <label key={row.key} className="grid grid-cols-[3.5rem_1fr_2.5rem] items-center gap-3 text-xs"><span className="font-semibold text-muted-foreground">{row.label}</span><Slider min={row.min} max={row.max} step={1} value={[adjustments[row.key]]} onValueChange={([value]) => onAdjustmentsChange({ ...adjustments, [row.key]: value })} /><span className="text-right tabular-nums text-muted-foreground">{adjustments[row.key]}</span></label>)}</div>
      </section>

      <Button variant="outline" className="w-full" onClick={onRotate}><RotateCw />顺时针旋转 90°</Button>
    </div>
  )
}
