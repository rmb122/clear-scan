import { CreditCard, FileText, MoreHorizontal, Plane, ScanLine } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ProjectSummary } from '@/hooks/use-projects'
import { formatDate } from '@/lib/utils'

const modeMeta = {
  'id-card': { label: '身份证', icon: CreditCard },
  passport: { label: '护照', icon: Plane },
  document: { label: '文档', icon: FileText },
}

export function ProjectCard({
  summary,
  onMenu,
}: {
  summary: ProjectSummary
  onMenu?: () => void
}) {
  const meta = modeMeta[summary.project.mode]
  return (
    <article className="group overflow-hidden rounded-2xl border border-border/80 bg-card transition hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-[0_16px_40px_rgba(20,50,38,.08)]">
      <Link to={`/project/${summary.project.id}`} className="block">
        <div className="relative aspect-[4/3] overflow-hidden bg-muted">
          {summary.thumbnailUrl ? (
            <img src={summary.thumbnailUrl} alt="" className="size-full object-cover transition duration-300 group-hover:scale-[1.02]" />
          ) : (
            <div className="grid size-full place-items-center text-muted-foreground"><ScanLine className="size-10 opacity-35" /></div>
          )}
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/35 to-transparent" />
          <Badge className="absolute left-3 top-3 border-white/60 bg-white/90 text-foreground backdrop-blur">
            <meta.icon className="size-3" /> {meta.label}
          </Badge>
          <span className="absolute bottom-3 right-3 rounded-full bg-black/55 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur">{summary.pageCount} 页</span>
        </div>
      </Link>
      <div className="flex items-center gap-3 p-4">
        <Link to={`/project/${summary.project.id}`} className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{summary.project.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{formatDate(summary.project.updatedAt)}</p>
        </Link>
        {onMenu && (
          <Button variant="ghost" size="icon" aria-label="项目操作" onClick={onMenu}>
            <MoreHorizontal />
          </Button>
        )}
      </div>
    </article>
  )
}
