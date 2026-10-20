import { useEffect, useState } from 'react'
import { Download, FileArchive, FileImage, FileText, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { SelectionButton } from '@/components/ui/selection-button'
import type { ExportFormat, PdfLayout } from '@/lib/exporters'
import type { IdCardSize } from '@/lib/id-card-layout'
import type { ScanPage, ScanProject } from '@/lib/types'
import { downloadBlob, cn } from '@/lib/utils'
import { messages } from '@/lib/i18n'
import { useLocale } from '@/hooks/use-locale'

export function ExportDialog({ project, pages }: { project: ScanProject; pages: ScanPage[] }) {
  useLocale()
  const isIdCard = project.mode === 'id-card'
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<ExportFormat>('pdf')
  const [layout, setLayout] = useState<PdfLayout>(isIdCard ? 'a4' : 'content')
  const [idCardSize, setIdCardSize] = useState<IdCardSize>('original')
  const [progress, setProgress] = useState(0)
  const [label, setLabel] = useState(messages.preparingExport)
  const [exporting, setExporting] = useState(false)
  const idComplete =
    !isIdCard ||
    (pages.some((page) => page.role === 'front') && pages.some((page) => page.role === 'back'))
  const allCropsConfirmed = pages.length > 0 && pages.every((page) => page.cropConfirmed)
  const formats: Array<{
    value: ExportFormat
    label: string
    description: string
    icon: typeof FileText
    hidden?: boolean
  }> = [
    {
      value: 'pdf',
      label: messages.pdfDocument,
      description: isIdCard ? messages.a4Combined : messages.pageCount(pages.length),
      icon: FileText,
    },
    {
      value: 'jpg',
      label: messages.jpgImage,
      description:
        pages.length > 1 && !isIdCard ? messages.singlePageOnly : messages.bestCompatibility,
      icon: FileImage,
      hidden: pages.length > 1 && !isIdCard,
    },
    {
      value: 'png',
      label: messages.pngImage,
      description: pages.length > 1 && !isIdCard ? messages.singlePageOnly : messages.lossless,
      icon: FileImage,
      hidden: pages.length > 1 && !isIdCard,
    },
    {
      value: 'zip',
      label: messages.zipImages,
      description: messages.jpgCount(pages.length),
      icon: FileArchive,
      hidden: isIdCard,
    },
  ]

  useEffect(() => {
    setFormat('pdf')
    setLayout(isIdCard ? 'a4' : 'content')
    setIdCardSize('original')
  }, [project.id, isIdCard])

  useEffect(() => {
    if (!isIdCard && pages.length > 1 && (format === 'jpg' || format === 'png')) {
      setFormat('pdf')
    }
  }, [format, pages.length, isIdCard])

  const runExport = async () => {
    setExporting(true)
    setLabel(messages.preparingExport)
    setProgress(1)
    try {
      const { exportProject } = await import('@/lib/exporters')
      const result = await exportProject(
        project,
        pages,
        format,
        layout,
        idCardSize,
        (value, nextLabel) => {
          setProgress(value)
          setLabel(nextLabel)
        },
      )
      downloadBlob(result.blob, result.fileName)
      toast.success(messages.exportComplete, { description: result.fileName })
      setOpen(false)
    } catch (reason) {
      toast.error(messages.exportFailed, {
        description: reason instanceof Error ? reason.message : messages.retryLater,
      })
    } finally {
      setExporting(false)
      setProgress(0)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !exporting && setOpen(nextOpen)}>
      <DialogTrigger asChild>
        <Button
          disabled={!pages.length || !idComplete || !allCropsConfirmed}
          title={!allCropsConfirmed ? messages.confirmCropsFirst : undefined}
          className="px-3 sm:px-4"
        >
          <Download />
          {messages.export}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{messages.exportTitle}</DialogTitle>
          <DialogDescription>{messages.exportPrivacy}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {formats
            .filter((item) => !item.hidden)
            .map((item) => (
              <button
                key={item.value}
                type="button"
                disabled={exporting}
                aria-pressed={format === item.value}
                onClick={() => setFormat(item.value)}
                className={cn(
                  'flex items-center gap-3 rounded-2xl border p-3 text-left transition',
                  format === item.value
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/15'
                    : 'border-border hover:border-primary/30',
                )}
              >
                <span className="grid size-9 place-items-center rounded-xl bg-secondary text-primary">
                  <item.icon className="size-4" />
                </span>
                <span>
                  <span className="block text-sm font-bold">{item.label}</span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              </button>
            ))}
        </div>
        {isIdCard && (
          <fieldset disabled={exporting}>
            <legend className="mb-2 text-xs font-bold">{messages.idCardExportSize}</legend>
            <div className="grid grid-cols-2 gap-1.5">
              <SelectionButton
                selected={idCardSize === 'original'}
                onClick={() => setIdCardSize('original')}
              >
                {messages.idCardOriginal}
              </SelectionButton>
              <SelectionButton
                selected={idCardSize === 'enlarged'}
                onClick={() => setIdCardSize('enlarged')}
              >
                {messages.idCardEnlarged}
              </SelectionButton>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {idCardSize === 'original'
                ? messages.idCardOriginalHint
                : messages.idCardEnlargedHint}
            </p>
          </fieldset>
        )}
        {format === 'pdf' && !isIdCard && (
          <div>
            <p className="mb-2 text-xs font-bold">{messages.pdfPageSize}</p>
            <div className="grid grid-cols-2 gap-1.5">
              <SelectionButton selected={layout === 'content'} onClick={() => setLayout('content')}>
                {messages.fitContent}
              </SelectionButton>
              <SelectionButton selected={layout === 'a4'} onClick={() => setLayout('a4')}>
                {messages.uniformA4}
              </SelectionButton>
            </div>
          </div>
        )}
        {exporting && (
          <div className="rounded-2xl bg-muted p-4">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 font-semibold">
                <LoaderCircle className="size-3.5 animate-spin" />
                {label}
              </span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} />
          </div>
        )}
        <Button size="lg" disabled={exporting} onClick={() => void runExport()}>
          {exporting ? <LoaderCircle className="animate-spin" /> : <Download />}
          {exporting ? messages.generating : messages.generateDownload}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
