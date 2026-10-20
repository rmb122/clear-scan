import { useMemo, useState } from 'react'
import {
  CreditCard,
  FileText,
  LoaderCircle,
  Plane,
  ScanLine,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ProjectCard } from '@/components/project-card'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useProjectSummaries } from '@/hooks/use-projects'
import { clearScannerData, deleteProject } from '@/lib/db'
import type { ScanMode } from '@/lib/types'
import { cn } from '@/lib/utils'
import { messages } from '@/lib/i18n'
import { useLocale } from '@/hooks/use-locale'

export function HistoryPage() {
  useLocale()
  const filters: Array<{ value: 'all' | ScanMode; label: string; icon?: typeof CreditCard }> = [
    { value: 'all', label: messages.all },
    { value: 'id-card', label: messages.idCard, icon: CreditCard },
    { value: 'passport', label: messages.passport, icon: Plane },
    { value: 'document', label: messages.document, icon: FileText },
  ]
  const { summaries, loading, reload } = useProjectSummaries()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | ScanMode>('all')
  const [deleteId, setDeleteId] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)

  const filtered = useMemo(
    () =>
      summaries.filter(
        ({ project }) =>
          (filter === 'all' || project.mode === filter) &&
          project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    [filter, query, summaries],
  )

  const confirmDelete = async () => {
    if (!deleteId || deleting) return
    const projectId = deleteId
    setDeleting(true)
    try {
      await deleteProject(projectId)
      setDeleteId(undefined)
      toast.success(messages.projectDeleted)
      try {
        await reload()
      } catch (reason) {
        toast.error(messages.historyRefreshFailed, {
          description: reason instanceof Error ? reason.message : messages.refreshRetry,
        })
      }
    } catch (reason) {
      toast.error(messages.projectDeleteFailed, {
        description: reason instanceof Error ? reason.message : messages.retryLater,
      })
    } finally {
      setDeleting(false)
    }
  }

  const clearAll = async () => {
    setClearing(true)
    try {
      await clearScannerData()
      await reload()
      setClearOpen(false)
      toast.success(messages.historyCleared)
    } catch (reason) {
      toast.error(messages.historyClearFailed, {
        description: reason instanceof Error ? reason.message : messages.closeOtherPages,
      })
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="min-h-[calc(100svh-4rem)] pb-20 pt-9 sm:pt-12">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.18em] text-primary">Local library</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{messages.history}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{messages.historyLocalNotice}</p>
        </div>
        {summaries.length > 0 && (
          <Button variant="destructive" disabled={clearing} onClick={() => setClearOpen(true)}>
            <Trash2 />
            {messages.clearHistory}
          </Button>
        )}
      </div>

      {(loading || summaries.length > 0) && (
        <div className="mt-8 flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative block flex-1 sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={messages.searchProjects}
              placeholder={messages.searchPlaceholder}
              className="h-10 w-full rounded-xl border border-border bg-background pl-10 pr-3 text-sm outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
            />
          </label>
          <div
            className="hide-scrollbar flex gap-1 overflow-x-auto"
            aria-label={messages.filterScanType}
          >
            {filters.map((item) => (
              <Button
                key={item.value}
                type="button"
                variant={filter === item.value ? 'secondary' : 'outline'}
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
                className={cn(
                  'h-9 gap-1.5 px-3 text-xs',
                  filter !== item.value && 'bg-muted text-foreground',
                )}
              >
                {item.icon && <item.icon className="size-3.5" />}
                {item.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="aspect-[4/3] animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : summaries.length === 0 ? (
        <Card className="mt-8 flex min-h-72 flex-col items-center justify-center border-dashed px-6 text-center">
          <span className="grid size-12 place-items-center rounded-2xl bg-secondary text-primary">
            <ScanLine />
          </span>
          <h2 className="mt-4 font-semibold">{messages.noHistory}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{messages.firstScanNotice}</p>
          <Button asChild className="mt-5">
            <Link to="/scan/document">{messages.startFirstScan}</Link>
          </Button>
        </Card>
      ) : filtered.length ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((summary) => (
            <ProjectCard
              key={summary.project.id}
              summary={summary}
              onMenu={() => setDeleteId(summary.project.id)}
            />
          ))}
        </div>
      ) : (
        <Card className="mt-6 flex min-h-72 flex-col items-center justify-center border-dashed text-center">
          <Search className="size-10 text-muted-foreground/35" />
          <h2 className="mt-4 font-semibold">{messages.noSearchResults}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{messages.searchAgain}</p>
        </Card>
      )}

      <Dialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => !open && !deleting && setDeleteId(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{messages.deleteProjectTitle}</DialogTitle>
            <DialogDescription>{messages.deleteProjectDescription}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteId(undefined)}>
              {messages.cancel}
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {deleting ? messages.deleting : messages.delete}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={clearOpen} onOpenChange={(open) => !clearing && setClearOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="text-destructive" />
              {messages.clearHistoryTitle}
            </DialogTitle>
            <DialogDescription>{messages.clearHistoryDescription}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={clearing} onClick={() => setClearOpen(false)}>
              {messages.cancel}
            </Button>
            <Button variant="destructive" disabled={clearing} onClick={() => void clearAll()}>
              {clearing && <LoaderCircle className="animate-spin" />}
              {messages.confirmClear}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
