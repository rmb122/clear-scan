import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ScanMode, ScanPage } from '@/lib/types'
import { cn } from '@/lib/utils'

export function PageRail({
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
  const [urls, setUrls] = useState<Record<string, string>>({})
  const sorted = useMemo(() => [...pages].sort((a, b) => a.order - b.order), [pages])
  useEffect(() => {
    const next: Record<string, string> = {}
    sorted.forEach((page) => {
      next[page.id] = URL.createObjectURL(page.thumbnail ?? page.source)
    })
    setUrls(next)
    return () => Object.values(next).forEach((url) => URL.revokeObjectURL(url))
  }, [sorted])

  return (
    <div
      aria-label="扫描页面"
      className="hide-scrollbar flex gap-2 overflow-x-auto p-3 lg:h-full lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden lg:p-3"
    >
      {sorted.map((page, index) => {
        const label = mode === 'id-card' ? (page.role === 'front' ? '人像面' : '国徽面') : `第 ${index + 1} 页`
        const active = page.id === activeId
        return (
          <div
            key={page.id}
            className={cn(
              'group relative shrink-0 rounded-xl border bg-background p-1 transition lg:w-full',
              active ? 'border-primary ring-2 ring-primary/15' : 'border-border hover:border-primary/30',
            )}
          >
            <button
              type="button"
              aria-label={`打开${label}`}
              aria-pressed={active}
              onClick={() => onSelect(page)}
              className="block w-28 lg:w-full"
            >
              <div className="aspect-[4/3] overflow-hidden rounded-lg bg-muted">
                <img src={urls[page.id]} alt="" className="size-full object-cover" />
              </div>
              <span className="mt-1.5 block truncate px-1 text-[10px] font-semibold">
                {label}
                {!page.cropConfirmed && <span className="ml-1 text-amber-600">待确认</span>}
              </span>
            </button>
            {active && (
              <div className="absolute right-1 top-1 flex overflow-hidden rounded-lg bg-black/65 text-white backdrop-blur">
                {mode !== 'id-card' && sorted.length > 1 && (
                  <>
                    <button
                      type="button"
                      aria-label={`${label}前移`}
                      disabled={index === 0}
                      onClick={() => onMove(page, -1)}
                      className="grid size-9 place-items-center transition hover:bg-white/10 disabled:opacity-30"
                    >
                      <ChevronLeft className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`${label}后移`}
                      disabled={index === sorted.length - 1}
                      onClick={() => onMove(page, 1)}
                      className="grid size-9 place-items-center transition hover:bg-white/10 disabled:opacity-30"
                    >
                      <ChevronRight className="size-3.5" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  aria-label={`删除${label}`}
                  onClick={() => onDelete(page)}
                  className="grid size-9 place-items-center transition hover:bg-white/10 hover:text-red-300"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        )
      })}
      {(mode !== 'id-card' || pages.length < 2) && (
        <Button
          variant="outline"
          onClick={onAdd}
          className="h-auto min-h-20 w-28 shrink-0 flex-col border-dashed text-xs lg:w-full"
        >
          <Plus />
          添加页面
        </Button>
      )}
    </div>
  )
}
