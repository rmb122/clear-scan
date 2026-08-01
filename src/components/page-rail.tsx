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
    sorted.forEach((page) => { next[page.id] = URL.createObjectURL(page.thumbnail ?? page.source) })
    setUrls(next)
    return () => Object.values(next).forEach((url) => URL.revokeObjectURL(url))
  }, [sorted])

  return (
    <div className="hide-scrollbar flex gap-2 overflow-x-auto p-3 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden lg:p-3">
      {sorted.map((page, index) => (
        <div key={page.id} className={cn('group relative shrink-0 rounded-xl border bg-background p-1 transition lg:w-full', page.id === activeId ? 'border-primary ring-2 ring-primary/15' : 'border-border hover:border-primary/30')}>
          <button type="button" onClick={() => onSelect(page)} className="block w-24 lg:w-full"><div className="aspect-[4/3] overflow-hidden rounded-lg bg-muted"><img src={urls[page.id]} alt="" className="size-full object-cover" /></div><span className="mt-1.5 block truncate px-1 text-[10px] font-semibold">{mode === 'id-card' ? page.role === 'front' ? '人像面' : '国徽面' : `第 ${index + 1} 页`}</span></button>
          {page.id === activeId && <div className="absolute right-1 top-1 flex rounded-lg bg-black/60 p-0.5 text-white backdrop-blur"><button type="button" title="前移" disabled={index === 0 || mode === 'id-card'} onClick={() => onMove(page, -1)} className="grid size-6 place-items-center disabled:opacity-30"><ChevronLeft className="size-3" /></button><button type="button" title="后移" disabled={index === sorted.length - 1 || mode === 'id-card'} onClick={() => onMove(page, 1)} className="grid size-6 place-items-center disabled:opacity-30"><ChevronRight className="size-3" /></button><button type="button" title="删除" onClick={() => onDelete(page)} className="grid size-6 place-items-center hover:text-red-300"><Trash2 className="size-3" /></button></div>}
        </div>
      ))}
      {(mode !== 'id-card' || pages.length < 2) && <Button variant="outline" onClick={onAdd} className="h-auto min-h-20 w-24 shrink-0 flex-col border-dashed text-xs lg:w-full"><Plus />添加页面</Button>}
    </div>
  )
}
