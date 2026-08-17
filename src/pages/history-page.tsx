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

const filters: Array<{ value: 'all' | ScanMode; label: string; icon?: typeof CreditCard }> = [
  { value: 'all', label: '全部' },
  { value: 'id-card', label: '身份证', icon: CreditCard },
  { value: 'passport', label: '护照', icon: Plane },
  { value: 'document', label: '文档', icon: FileText },
]

export function HistoryPage() {
  const { summaries, loading, reload } = useProjectSummaries()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | ScanMode>('all')
  const [deleteId, setDeleteId] = useState<string>()
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
    if (!deleteId) return
    await deleteProject(deleteId)
    setDeleteId(undefined)
    await reload()
    toast.success('扫描项目已删除')
  }

  const clearAll = async () => {
    setClearing(true)
    try {
      await clearScannerData()
      await reload()
      setClearOpen(false)
      toast.success('所有扫描历史已清空')
    } catch (reason) {
      toast.error('扫描历史清理失败', {
        description: reason instanceof Error ? reason.message : '请关闭其他页面后重试',
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
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">扫描记录</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            所有项目只保存在此设备的当前浏览器中。
          </p>
        </div>
        {summaries.length > 0 && (
          <Button variant="destructive" disabled={clearing} onClick={() => setClearOpen(true)}>
            <Trash2 />
            清空所有历史数据
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
              aria-label="搜索扫描项目"
              placeholder="搜索项目名称"
              className="h-10 w-full rounded-xl border border-border bg-background pl-10 pr-3 text-sm outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/10"
            />
          </label>
          <div className="hide-scrollbar flex gap-1 overflow-x-auto" aria-label="扫描类型筛选">
            {filters.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
                className={cn(
                  'flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-muted-foreground transition hover:bg-muted',
                  filter === item.value && 'bg-secondary text-secondary-foreground',
                )}
              >
                {item.icon && <item.icon className="size-3.5" />}
                {item.label}
              </button>
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
          <h2 className="mt-4 font-semibold">还没有扫描记录</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            扫描第一份文档后，会自动保存在当前浏览器中。
          </p>
          <Button asChild className="mt-5">
            <Link to="/scan/document">开始第一次扫描</Link>
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
          <h2 className="mt-4 font-semibold">没有找到扫描项目</h2>
          <p className="mt-1 text-sm text-muted-foreground">换个关键词或筛选条件试试。</p>
        </Card>
      )}

      <Dialog open={Boolean(deleteId)} onOpenChange={(open) => !open && setDeleteId(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这个扫描项目？</DialogTitle>
            <DialogDescription>
              原图、裁剪设置和本地缩略图都会永久移除，此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteId(undefined)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              <Trash2 />
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={clearOpen} onOpenChange={(open) => !clearing && setClearOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="text-destructive" />
              清空所有扫描历史？
            </DialogTitle>
            <DialogDescription>
              所有项目、原图、缩略图、编辑设置和页面缓存都会永久删除，已经导出的文件不受影响。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={clearing} onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={clearing} onClick={() => void clearAll()}>
              {clearing && <LoaderCircle className="animate-spin" />}
              确认清空
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
