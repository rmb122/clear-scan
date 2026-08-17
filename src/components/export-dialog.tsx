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
import type { ExportFormat, PdfLayout } from '@/lib/exporters'
import type { ScanPage, ScanProject } from '@/lib/types'
import { downloadBlob, cn } from '@/lib/utils'

export function ExportDialog({ project, pages }: { project: ScanProject; pages: ScanPage[] }) {
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<ExportFormat>('pdf')
  const [layout, setLayout] = useState<PdfLayout>(project.mode === 'id-card' ? 'a4' : 'content')
  const [progress, setProgress] = useState(0)
  const [label, setLabel] = useState('准备导出')
  const [exporting, setExporting] = useState(false)
  const idComplete =
    project.mode !== 'id-card' ||
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
      label: 'PDF 文档',
      description: project.mode === 'id-card' ? 'A4 单页 · 大图排版' : `${pages.length} 页`,
      icon: FileText,
    },
    {
      value: 'jpg',
      label: 'JPG 图片',
      description: pages.length > 1 && project.mode !== 'id-card' ? '仅限单页' : '兼容性最好',
      icon: FileImage,
      hidden: pages.length > 1 && project.mode !== 'id-card',
    },
    {
      value: 'png',
      label: 'PNG 图片',
      description: pages.length > 1 && project.mode !== 'id-card' ? '仅限单页' : '无损格式',
      icon: FileImage,
      hidden: pages.length > 1 && project.mode !== 'id-card',
    },
    {
      value: 'zip',
      label: '图片包 ZIP',
      description: `${pages.length} 张 JPG`,
      icon: FileArchive,
      hidden: project.mode === 'id-card',
    },
  ]

  useEffect(() => {
    setFormat('pdf')
    setLayout(project.mode === 'id-card' ? 'a4' : 'content')
  }, [project.id, project.mode])

  useEffect(() => {
    if (project.mode !== 'id-card' && pages.length > 1 && (format === 'jpg' || format === 'png')) {
      setFormat('pdf')
    }
  }, [format, pages.length, project.mode])

  const runExport = async () => {
    setExporting(true)
    setProgress(1)
    try {
      const { exportProject } = await import('@/lib/exporters')
      const result = await exportProject(project, pages, format, layout, (value, nextLabel) => {
        setProgress(value)
        setLabel(nextLabel)
      })
      downloadBlob(result.blob, result.fileName)
      toast.success('导出完成', { description: result.fileName })
      setOpen(false)
    } catch (reason) {
      toast.error('导出失败', {
        description: reason instanceof Error ? reason.message : '请稍后重试',
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
          title={!allCropsConfirmed ? '请先确认所有页面的裁剪边缘' : undefined}
        >
          <Download />
          导出
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导出扫描结果</DialogTitle>
          <DialogDescription>
            文件在本机生成，导出图片不会携带原照片的 EXIF 或定位信息。
          </DialogDescription>
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
        {format === 'pdf' && project.mode !== 'id-card' && (
          <div>
            <p className="mb-2 text-xs font-bold">PDF 页面尺寸</p>
            <div className="grid grid-cols-2 rounded-xl bg-muted p-1">
              <button
                type="button"
                aria-pressed={layout === 'content'}
                onClick={() => setLayout('content')}
                className={cn(
                  'h-9 rounded-lg text-xs font-semibold',
                  layout === 'content' && 'bg-background shadow-sm',
                )}
              >
                适应内容
              </button>
              <button
                type="button"
                aria-pressed={layout === 'a4'}
                onClick={() => setLayout('a4')}
                className={cn(
                  'h-9 rounded-lg text-xs font-semibold',
                  layout === 'a4' && 'bg-background shadow-sm',
                )}
              >
                统一 A4
              </button>
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
          {exporting ? '正在生成…' : '生成并下载'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
