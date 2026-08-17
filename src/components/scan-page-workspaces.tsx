import type { RefObject } from 'react'
import { Check, Crop, FileCheck2, LoaderCircle, RotateCcw } from 'lucide-react'
import { CapturePanel } from '@/components/capture-panel'
import { CropEditor } from '@/components/crop-editor'
import { FilterPanel } from '@/components/filter-panel'
import type { ScanStage } from '@/components/scan-page-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type {
  EnhancementEffect,
  EnhancementEffects,
  EnhancementSettings,
  NormalizedQuad,
  PageRole,
  PassportLayout,
  ScanMode,
  ScanPage,
} from '@/lib/types'
import { cn } from '@/lib/utils'

type EditorStage = Exclude<ScanStage, 'capture'>
type RotationDirection = 'counterclockwise' | 'clockwise'

export function ScanCaptureWorkspace({
  mode,
  passportLayout,
  nextRole,
  busy,
  progress,
  progressLabel,
  onPassportLayoutChange,
  onFiles,
}: {
  mode: ScanMode
  passportLayout: PassportLayout
  nextRole: PageRole
  busy: boolean
  progress: number
  progressLabel: string
  onPassportLayoutChange: (layout: PassportLayout) => void
  onFiles: (files: File[]) => void
}) {
  return (
    <div className="lg:col-span-2 lg:min-h-0 lg:overflow-y-auto">
      <CapturePanel
        mode={mode}
        passportLayout={passportLayout}
        nextRole={nextRole}
        busy={busy}
        onPassportLayoutChange={onPassportLayoutChange}
        onFiles={onFiles}
      />
      {busy && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[#081711]/55 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl">
            <div className="flex items-center gap-3">
              <LoaderCircle className="size-5 animate-spin text-primary" />
              <div>
                <p className="text-sm font-bold">正在处理照片</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{progressLabel}</p>
              </div>
            </div>
            <Progress value={progress} className="mt-4" />
          </div>
        </div>
      )}
    </div>
  )
}

function CropControls({
  page,
  busy,
  onRedetect,
  onConfirm,
}: {
  page: ScanPage
  busy: boolean
  onRedetect: () => void
  onConfirm: () => void
}) {
  const status =
    page.cornerSource === 'detected'
      ? '预识别结果待确认'
      : page.cornerSource === 'manual'
        ? '已手动调整，等待确认'
        : page.cornerSource === 'fallback'
          ? '需要手动调整'
          : '需要人工确认'

  return (
    <div className="space-y-5">
      <div>
        <Badge
          variant={
            page.cornerSource === 'detected' || page.cornerSource === 'manual'
              ? 'default'
              : 'warning'
          }
        >
          {status}
        </Badge>
        <h2 className="mt-3 text-xl font-bold">确认四个角点</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          拖动边框外侧的绿色圆柄，让短线所指的角点贴合证件或纸张；拖动时可通过放大镜精确对齐。
        </p>
      </div>
      <div className="rounded-2xl bg-muted p-4 text-xs leading-5 text-muted-foreground">
        <p className="font-bold text-foreground">裁剪小技巧</p>
        <ul className="mt-2 space-y-1.5">
          <li>· 边缘宁可稍微向内，不要带入桌面背景</li>
          <li>· 护照展开双页应包含完整装订线</li>
          <li>· 旋转可以在下一步继续调整</li>
        </ul>
      </div>
      <Button variant="outline" size="lg" className="w-full" disabled={busy} onClick={onRedetect}>
        <RotateCcw />
        重新识别
      </Button>
      <Button size="lg" className="w-full" onClick={onConfirm}>
        <Check />
        确认裁剪
      </Button>
    </div>
  )
}

function EnhancementControls({
  page,
  previewIsCurrent,
  rendering,
  onEffectChange,
  onPresetApply,
  onAdjustmentsChange,
  onRotate,
  onReopenCrop,
  onSave,
}: {
  page: ScanPage
  previewIsCurrent: boolean
  rendering: boolean
  onEffectChange: (category: keyof EnhancementEffects, effect: EnhancementEffect) => void
  onPresetApply: (preset: 'original' | 'smart') => void
  onAdjustmentsChange: (adjustments: EnhancementSettings) => void
  onRotate: (direction: RotationDirection) => void
  onReopenCrop: () => void
  onSave: () => void
}) {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold">调整扫描效果</h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          不同分类可以叠加，同一分类始终只保留一个效果。
        </p>
      </div>
      <FilterPanel
        effects={page.effects}
        adjustments={page.adjustments}
        glareLevel={page.glareLevel}
        onEffectChange={onEffectChange}
        onPresetApply={onPresetApply}
        onAdjustmentsChange={onAdjustmentsChange}
        onRotate={onRotate}
      />
      <div className="mt-6 grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={onReopenCrop}>
          <Crop />
          调整边缘
        </Button>
        <Button disabled={!previewIsCurrent || rendering} onClick={onSave}>
          <FileCheck2 />
          保存页面
        </Button>
      </div>
    </div>
  )
}

export function ScanEditorWorkspace({
  stage,
  workspaceRef,
  page,
  sourceUrl,
  previewUrl,
  previewIsCurrent,
  rendering,
  busy,
  onCropChange,
  onRedetect,
  onConfirmCrop,
  onEffectChange,
  onPresetApply,
  onAdjustmentsChange,
  onRotate,
  onReopenCrop,
  onSave,
}: {
  stage: EditorStage
  workspaceRef: RefObject<HTMLElement | null>
  page?: ScanPage
  sourceUrl?: string
  previewUrl?: string
  previewIsCurrent: boolean
  rendering: boolean
  busy: boolean
  onCropChange: (corners: NormalizedQuad) => void
  onRedetect: () => void
  onConfirmCrop: () => void
  onEffectChange: (category: keyof EnhancementEffects, effect: EnhancementEffect) => void
  onPresetApply: (preset: 'original' | 'smart') => void
  onAdjustmentsChange: (adjustments: EnhancementSettings) => void
  onRotate: (direction: RotationDirection) => void
  onReopenCrop: () => void
  onSave: () => void
}) {
  return (
    <>
      <section
        ref={workspaceRef}
        className="paper-grid relative min-h-[480px] scroll-mt-16 overflow-hidden lg:h-full lg:min-h-0"
      >
        {stage === 'crop' && page && sourceUrl && (
          <CropEditor
            sourceUrl={sourceUrl}
            width={page.width}
            height={page.height}
            corners={page.corners}
            cornerSource={page.cornerSource}
            onChange={onCropChange}
          />
        )}
        {stage === 'enhance' &&
          page &&
          (previewUrl ? (
            <div className="flex size-full items-center justify-center p-4 sm:p-8">
              <img
                src={previewUrl}
                alt="扫描增强预览"
                className={cn(
                  'max-h-full max-w-full object-contain shadow-[0_20px_65px_rgba(0,0,0,.5)] transition-opacity',
                  (rendering || !previewIsCurrent) && 'opacity-55',
                )}
              />
            </div>
          ) : (
            <div
              className="absolute inset-0 grid place-items-center p-4"
              role="status"
              aria-live="polite"
            >
              <div className="flex flex-col items-center gap-3 text-white/75">
                <LoaderCircle className="size-8 animate-spin" />
                <span className="text-xs font-semibold">正在生成增强预览</span>
              </div>
            </div>
          ))}
        {(rendering || !previewIsCurrent) && previewUrl && (
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-[10px] font-semibold text-white backdrop-blur">
            <LoaderCircle className="size-3 animate-spin" />
            正在更新效果
          </div>
        )}
      </section>

      <aside className="border-t border-border bg-card p-5 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:p-6">
        {stage === 'crop' && page && (
          <CropControls page={page} busy={busy} onRedetect={onRedetect} onConfirm={onConfirmCrop} />
        )}
        {stage === 'enhance' && page && (
          <EnhancementControls
            page={page}
            previewIsCurrent={previewIsCurrent}
            rendering={rendering}
            onEffectChange={onEffectChange}
            onPresetApply={onPresetApply}
            onAdjustmentsChange={onAdjustmentsChange}
            onRotate={onRotate}
            onReopenCrop={onReopenCrop}
            onSave={onSave}
          />
        )}
      </aside>
    </>
  )
}
