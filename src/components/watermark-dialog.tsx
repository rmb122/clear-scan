import { useState } from 'react'
import { LoaderCircle, Stamp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { useLocale } from '@/hooks/use-locale'
import { messages } from '@/lib/i18n'
import { DEFAULT_WATERMARK, type WatermarkSettings } from '@/lib/types'
import { cn } from '@/lib/utils'

export function WatermarkDialog({
  settings = { ...DEFAULT_WATERMARK, text: messages.watermarkDefaultText },
  onChange,
  disabled,
  previewAvailable,
  previewUrl,
  previewIsCurrent,
}: {
  settings?: WatermarkSettings
  onChange: (settings: WatermarkSettings) => void
  disabled: boolean
  previewAvailable: boolean
  previewUrl?: string
  previewIsCurrent: boolean
}) {
  useLocale()
  const [open, setOpen] = useState(false)
  const sliders: Array<{
    key: 'fontSize' | 'opacity' | 'angle' | 'spacing'
    label: string
    min: number
    max: number
    unit?: string
  }> = [
    { key: 'fontSize', label: messages.watermarkFontSize, min: 12, max: 96 },
    { key: 'opacity', label: messages.watermarkOpacity, min: 5, max: 100, unit: '%' },
    { key: 'angle', label: messages.watermarkAngle, min: -90, max: 90, unit: messages.angleUnit },
    { key: 'spacing', label: messages.watermarkSpacing, min: 20, max: 240 },
  ]

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={settings.enabled ? 'secondary' : 'outline'}
          aria-pressed={settings.enabled}
          disabled={disabled}
          className="px-3 sm:px-4"
        >
          <Stamp />
          {messages.watermark}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{messages.watermarkSettings}</DialogTitle>
          <DialogDescription>{messages.watermarkProjectHint}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]">
          <div
            className="paper-grid relative flex h-44 min-w-0 items-center justify-center overflow-hidden rounded-2xl p-3 md:h-full md:min-h-80"
            aria-busy={previewAvailable && !previewIsCurrent}
          >
            {!previewAvailable ? (
              <p className="max-w-xs text-center text-sm leading-6 text-white/75">
                {messages.watermarkPreviewRequiresCrop}
              </p>
            ) : previewUrl ? (
              <img
                src={previewUrl}
                alt={messages.watermarkPreviewAlt}
                className={cn(
                  'max-h-full max-w-full object-contain shadow-lg md:max-h-[55svh]',
                  !previewIsCurrent && 'opacity-55',
                )}
              />
            ) : null}
            {previewAvailable && !previewIsCurrent && (
              <div
                role="status"
                className="absolute bottom-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white"
              >
                <LoaderCircle className="size-3.5 animate-spin" />
                {messages.generatingPreview}
              </div>
            )}
          </div>
          <div className="space-y-4">
            <Button
              role="switch"
              aria-checked={settings.enabled}
              variant={settings.enabled ? 'secondary' : 'outline'}
              className="w-full"
              onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
            >
              <Stamp />
              {messages.enableWatermark}
            </Button>
            <fieldset disabled={!settings.enabled} className="space-y-4 disabled:opacity-50">
              <label className="block space-y-2 text-sm font-semibold">
                <span>{messages.watermarkText}</span>
                <input
                  type="text"
                  value={settings.text}
                  onChange={(event) => onChange({ ...settings, text: event.target.value })}
                  placeholder={messages.watermarkPlaceholder}
                  className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-sm font-semibold">
                <span>{messages.watermarkColor}</span>
                <input
                  type="color"
                  value={settings.color}
                  onChange={(event) => onChange({ ...settings, color: event.target.value })}
                  className="h-9 w-16 cursor-pointer rounded-lg border border-input bg-background p-1"
                />
              </label>
              {sliders.map(({ key, label, min, max, unit = '' }) => (
                <div key={key} className="space-y-2">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-semibold">{label}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {settings[key]}
                      {unit}
                    </span>
                  </div>
                  <Slider
                    aria-label={label}
                    min={min}
                    max={max}
                    step={1}
                    value={[settings[key]]}
                    disabled={!settings.enabled}
                    onValueChange={([value]) => onChange({ ...settings, [key]: value })}
                  />
                </div>
              ))}
            </fieldset>
            <p className="text-xs leading-5 text-muted-foreground">
              {messages.watermarkBoundsHint}
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => setOpen(false)}>{messages.watermarkDone}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
