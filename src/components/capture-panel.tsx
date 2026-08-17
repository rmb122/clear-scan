import { useRef, useState } from 'react'
import { Camera, CloudUpload, CreditCard, FileImage, Images, Laptop, Plane } from 'lucide-react'
import { toast } from 'sonner'
import { CameraDialog } from './camera-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { PageRole, PassportLayout, ScanMode } from '@/lib/types'
import { cn } from '@/lib/utils'

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
  const cameraInput = useRef<HTMLInputElement>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const [webcamOpen, setWebcamOpen] = useState(false)
  const [dragging, setDragging] = useState(false)

  const title =
    mode === 'id-card'
      ? `拍摄身份证${nextRole === 'front' ? '人像面' : '国徽面'}`
      : mode === 'passport'
        ? passportLayout === 'spread'
          ? '拍摄护照展开双页'
          : '拍摄护照资料页'
        : '添加文档页面'
  const Icon = mode === 'id-card' ? CreditCard : mode === 'passport' ? Plane : FileImage

  const receive = (list: FileList | null) => {
    if (!list?.length) return
    const files = Array.from(list).filter(
      (file) => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name),
    )
    if (!files.length) {
      toast.error('没有可用的图片', { description: '请选择 JPEG、PNG、WebP、HEIC 或 HEIF 文件。' })
      return
    }
    if (files.length < list.length)
      toast.warning(`已跳过 ${list.length - files.length} 个不支持的文件`)
    if (mode !== 'document' && files.length > 1) toast('证件模式每次只添加一张照片')
    onFiles(mode === 'document' ? files : files.slice(0, 1))
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-8 sm:py-12">
      <div className="grid size-14 place-items-center rounded-2xl bg-secondary text-primary">
        <Icon className="size-7" />
      </div>
      <Badge className="mt-4">
        {mode === 'id-card' ? '双面合成' : mode === 'passport' ? '护照专用比例' : '支持连续多页'}
      </Badge>
      <h2 className="mt-3 text-center text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
      <p className="mt-2 max-w-lg text-center text-sm leading-6 text-muted-foreground">
        保持镜头与纸面平行，避免强光直射。照片返回后会自动寻找边缘，你仍可手动调整四角。
      </p>

      {mode === 'passport' && (
        <div className="mt-6 grid w-full max-w-sm grid-cols-2 rounded-xl bg-muted p-1">
          {(['data-page', 'spread'] as const).map((layout) => (
            <button
              key={layout}
              type="button"
              onClick={() => onPassportLayoutChange(layout)}
              className={cn(
                'h-9 rounded-lg text-xs font-semibold text-muted-foreground transition',
                passportLayout === layout && 'bg-background text-foreground shadow-sm',
              )}
            >
              {layout === 'data-page' ? '资料页单页' : '展开双页'}
            </button>
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
          receive(event.dataTransfer.files)
        }}
      >
        <div className="rounded-[1.3rem] bg-muted/65 px-5 py-8 text-center sm:px-10 sm:py-10">
          <CloudUpload className="mx-auto size-9 text-primary/70" />
          <h3 className="mt-3 text-sm font-bold">使用系统相机获得更清晰的原图</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            也可以拖放照片到这里。支持 JPEG、PNG、WebP 和浏览器可解码的 HEIC。
          </p>
          <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
            <Button size="lg" disabled={busy} onClick={() => cameraInput.current?.click()}>
              <Camera />
              系统相机拍摄
            </Button>
            <Button
              size="lg"
              variant="outline"
              disabled={busy}
              onClick={() => uploadInput.current?.click()}
            >
              <Images />
              从相册或电脑上传
            </Button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => setWebcamOpen(true)}
            className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-muted-foreground transition hover:bg-background hover:text-primary"
          >
            <Laptop className="size-3.5" />
            使用网页摄像头
          </button>
        </div>
      </Card>

      <div className="mt-5 grid w-full grid-cols-3 gap-2 text-center text-[10px] font-semibold text-muted-foreground">
        <span>1. 拍照/上传</span>
        <span>2. 确认边缘</span>
        <span>3. 增强并导出</span>
      </div>
      <input
        ref={cameraInput}
        hidden
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
