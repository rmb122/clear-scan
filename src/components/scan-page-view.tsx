import type { ReactNode } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  Crop,
  LoaderCircle,
  Pencil,
  ScanLine,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { ExportDialog } from '@/components/export-dialog'
import { PageRail } from '@/components/page-rail'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ScanMode, ScanPage, ScanProject } from '@/lib/types'
import { cn } from '@/lib/utils'
import { messages } from '@/lib/i18n'
import { useLocale } from '@/hooks/use-locale'

export type ScanStage = 'capture' | 'crop' | 'enhance'

export function ScanPageHeader({
  mode,
  project,
  pages,
  onBack,
  onRename,
  watermarkControl,
}: {
  mode: ScanMode
  project?: ScanProject
  pages: ScanPage[]
  onBack: () => void
  onRename: (name: string) => void
  watermarkControl?: ReactNode
}) {
  useLocale()
  const modeLabels: Record<ScanMode, string> = {
    'id-card': messages.idCardScan,
    passport: messages.passportScan,
    document: messages.documentScan,
  }
  return (
    <div className="border-b border-border/80 bg-card lg:shrink-0">
      <div className="mx-auto grid max-w-[1480px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto] sm:px-6">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={messages.backHome}>
          <ArrowLeft />
        </Button>
        <div className="col-span-3 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 whitespace-nowrap sm:col-span-1 sm:col-start-2 sm:row-start-1">
          <Badge variant="secondary">{modeLabels[mode]}</Badge>
          <span className="text-[10px] font-semibold text-muted-foreground">
            {messages.pageCount(pages.length)}
          </span>
        </div>
        {project ? (
          <div className="group col-span-3 row-start-3 w-fit min-w-0 max-w-full sm:col-span-1 sm:col-start-3 sm:row-start-1">
            <label
              className="flex max-w-sm cursor-text items-center gap-2 border-b border-transparent py-1 transition hover:border-border focus-within:border-primary"
              title={messages.renameHint}
            >
              <Pencil
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground transition group-hover:text-primary group-focus-within:text-primary"
              />
              <span className="relative min-w-0 text-sm font-bold">
                <span
                  aria-hidden="true"
                  className="invisible block overflow-hidden pr-4 whitespace-pre"
                >
                  {project.name || messages.untitled}
                </span>
                <input
                  value={project.name}
                  onChange={(event) => onRename(event.target.value)}
                  className="absolute inset-0 size-full min-w-0 truncate bg-transparent pr-4 outline-none"
                  aria-label={messages.projectName}
                  placeholder={messages.untitled}
                />
              </span>
            </label>
          </div>
        ) : (
          <h1 className="col-span-3 row-start-3 text-sm font-bold sm:col-span-1 sm:col-start-3 sm:row-start-1">
            {messages.newScan(modeLabels[mode])}
          </h1>
        )}
        <div className="col-span-2 col-start-2 row-start-1 flex items-center justify-self-end gap-2 sm:col-span-1 sm:col-start-4">
          {watermarkControl}
          {project && <ExportDialog project={project} pages={pages} />}
        </div>
      </div>
    </div>
  )
}

export function ScanStageNavigation({ stage }: { stage: ScanStage }) {
  useLocale()
  const scanSteps = [
    { key: 'capture', label: messages.captureStep, icon: ScanLine },
    { key: 'crop', label: messages.cropStep, icon: Crop },
    { key: 'enhance', label: messages.enhanceStep, icon: Sparkles },
  ] as const
  return (
    <div className="border-b border-border/80 bg-background lg:shrink-0">
      <div className="mx-auto max-w-[1480px] px-4 py-2.5 sm:px-6">
        <div className="mx-auto flex max-w-xl items-center justify-between text-[10px] font-semibold text-muted-foreground">
          {scanSteps.map((step, index) => (
            <div key={step.key} className="contents">
              <span
                className={cn('flex items-center gap-1.5', stage === step.key && 'text-primary')}
              >
                <span
                  className={cn(
                    'grid size-6 place-items-center rounded-full bg-muted',
                    stage === step.key && 'bg-primary text-white',
                  )}
                >
                  <step.icon className="size-3" />
                </span>
                {step.label}
              </span>
              {index < scanSteps.length - 1 && <ChevronRight className="size-3 text-border" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ScanPageNavigation({
  mode,
  pages,
  activeId,
  onSelect,
  onAdd,
  onDelete,
  onMove,
}: {
  mode: ScanMode
  pages: ScanPage[]
  activeId?: string
  onSelect: (page: ScanPage) => void
  onAdd: () => void
  onDelete: (page: ScanPage) => void
  onMove: (page: ScanPage, direction: -1 | 1) => void
}) {
  return (
    <aside
      className={cn(
        'border-b border-border bg-card lg:h-full lg:border-b-0 lg:border-r',
        pages.length === 0 && 'hidden lg:block',
      )}
    >
      <PageRail
        mode={mode}
        pages={pages}
        activeId={activeId}
        onSelect={onSelect}
        onAdd={onAdd}
        onDelete={onDelete}
        onMove={onMove}
      />
    </aside>
  )
}

export function ScanDeleteDialog({
  open,
  pageLabel,
  deleting,
  onClose,
  onConfirm,
}: {
  open: boolean
  pageLabel: string
  deleting: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  useLocale()
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !deleting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="text-destructive" />
            <span>{messages.deletePageTitle(pageLabel)}</span>
          </DialogTitle>
          <DialogDescription>{messages.deletePageDescription}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={deleting} onClick={onClose}>
            {messages.cancel}
          </Button>
          <Button variant="destructive" disabled={deleting} onClick={onConfirm}>
            {deleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            {messages.confirmDelete}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
