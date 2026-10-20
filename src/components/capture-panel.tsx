import { useRef, useState } from 'react'
import { Camera, CloudUpload, CreditCard, FileImage, Images, Laptop, Plane } from 'lucide-react'
import { toast } from 'sonner'
import { CameraDialog } from './camera-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { SelectionButton } from '@/components/ui/selection-button'
import type { PageRole, PassportLayout, ScanMode } from '@/lib/types'
import { cn } from '@/lib/utils'
import { messages } from '@/lib/i18n'
import { useLocale } from '@/hooks/use-locale'

export function CapturePanel({
  mode,
  passportLayout,
  nextRole,
  busy,
  onPassportLayoutChange,
  onFiles,
}: {
  mode: ScanMode
  passportLayout: PassportLayout
  nextRole: PageRole
  busy: boolean
  onPassportLayoutChange: (layout: PassportLayout) => void
  onFiles: (files: File[]) => void
}) {
  useLocale()
  const cameraInput = useRef<HTMLInputElement>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const [webcamOpen, setWebcamOpen] = useState(false)
  const [dragging, setDragging] = useState(false)

  const title =
    mode === 'id-card'
      ? messages.captureIdSide(nextRole === 'front' ? messages.frontSide : messages.backSide)
      : mode === 'passport'
        ? passportLayout === 'spread'
          ? messages.capturePassportSpread
          : messages.capturePassportData
        : messages.addDocumentPages
  const Icon = mode === 'id-card' ? CreditCard : mode === 'passport' ? Plane : FileImage

  const receive = (list: FileList | null) => {
    if (busy || !list?.length) return
    const files = Array.from(list).filter(
      (file) => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name),
    )
    if (!files.length) {
      toast.error(messages.noUsableImages, { description: messages.supportedFiles })
      return
    }
    if (files.length < list.length) toast.warning(messages.skippedFiles(list.length - files.length))
    if (mode !== 'document' && files.length > 1) toast(messages.singleIdPhoto)
    onFiles(mode === 'document' ? files : files.slice(0, 1))
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-8 sm:py-12">
      <div className="grid size-14 place-items-center rounded-2xl bg-secondary text-primary">
        <Icon className="size-7" />
      </div>
      <Badge className="mt-4">
        {mode === 'id-card'
          ? messages.bothSides
          : mode === 'passport'
            ? messages.passportRatio
            : messages.multiplePages}
      </Badge>
      <h2 className="mt-3 text-center text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
      <p className="mt-2 max-w-lg text-center text-sm leading-6 text-muted-foreground">
        {messages.captureHint}
      </p>

      {mode === 'passport' && (
        <div className="mt-6 grid w-full max-w-sm grid-cols-2 gap-1.5">
          {(['data-page', 'spread'] as const).map((layout) => (
            <SelectionButton
              key={layout}
              selected={passportLayout === layout}
              disabled={busy}
              onClick={() => onPassportLayoutChange(layout)}
            >
              {layout === 'data-page' ? messages.passportDataPage : messages.passportSpread}
            </SelectionButton>
          ))}
        </div>
      )}

      <Card
        className={cn(
          'mt-7 w-full border-dashed p-3 transition',
          dragging && 'border-primary bg-primary/[.03]',
        )}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (busy) return
          receive(event.dataTransfer.files)
        }}
      >
        <div className="rounded-[1.3rem] bg-muted/65 px-5 py-8 text-center sm:px-10 sm:py-10">
          <CloudUpload className="mx-auto size-9 text-primary/70" />
          <h3 className="mt-3 text-sm font-bold">{messages.systemCameraHint}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{messages.dropHint}</p>
          <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
            <Button size="lg" disabled={busy} onClick={() => cameraInput.current?.click()}>
              <Camera />
              {messages.useSystemCamera}
            </Button>
            <Button
              size="lg"
              variant="outline"
              disabled={busy}
              onClick={() => uploadInput.current?.click()}
            >
              <Images />
              {messages.uploadPhotos}
            </Button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => setWebcamOpen(true)}
            className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-muted-foreground transition hover:bg-background hover:text-primary"
          >
            <Laptop className="size-3.5" />
            {messages.useWebcam}
          </button>
        </div>
      </Card>

      <div className="mt-5 grid w-full grid-cols-3 gap-2 text-center text-[10px] font-semibold text-muted-foreground">
        <span>{messages.captureStepNumbered}</span>
        <span>{messages.cropStepNumbered}</span>
        <span>{messages.enhanceStepNumbered}</span>
      </div>
      <input
        ref={cameraInput}
        hidden
        disabled={busy}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => {
          receive(event.target.files)
          event.currentTarget.value = ''
        }}
      />
      <input
        ref={uploadInput}
        hidden
        disabled={busy}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        multiple={mode === 'document'}
        onChange={(event) => {
          receive(event.target.files)
          event.currentTarget.value = ''
        }}
      />
      <CameraDialog
        open={webcamOpen}
        onOpenChange={setWebcamOpen}
        onCapture={(file) => onFiles([file])}
      />
    </div>
  )
}
