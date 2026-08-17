import { useCallback, useEffect, useRef, useState } from 'react'
import { db, getProjectPageSummary } from '@/lib/db'
import type { ScanProject } from '@/lib/types'

export interface ProjectSummary {
  project: ScanProject
  pageCount: number
  thumbnailUrl?: string
}

function revokeThumbnailUrls(summaries: ProjectSummary[]) {
  summaries.forEach((summary) => summary.thumbnailUrl && URL.revokeObjectURL(summary.thumbnailUrl))
}

export function useProjectSummaries(limit?: number) {
  const [summaries, setSummaries] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const summariesRef = useRef<ProjectSummary[]>([])
  const loadVersionRef = useRef(0)

  const replaceSummaries = useCallback((next: ProjectSummary[]) => {
    revokeThumbnailUrls(summariesRef.current)
    summariesRef.current = next
    setSummaries(next)
  }, [])

  const load = useCallback(async () => {
    const loadVersion = ++loadVersionRef.current
    setLoading(true)
    try {
      const projects = await db.projects.orderBy('updatedAt').reverse().toArray()
      const selected = typeof limit === 'number' ? projects.slice(0, limit) : projects
      const projectSummaries = await Promise.all(
        selected.map(async (project) => {
          const { pageCount, thumbnail } = await getProjectPageSummary(project.id)
          return { project, pageCount, thumbnail }
        }),
      )
      if (loadVersion !== loadVersionRef.current) return
      replaceSummaries(
        projectSummaries.map(({ project, pageCount, thumbnail }) => ({
          project,
          pageCount,
          thumbnailUrl: thumbnail ? URL.createObjectURL(thumbnail) : undefined,
        })),
      )
    } finally {
      if (loadVersion === loadVersionRef.current) setLoading(false)
    }
  }, [limit, replaceSummaries])

  useEffect(() => {
    void load().catch(() => undefined)
    return () => {
      loadVersionRef.current += 1
      revokeThumbnailUrls(summariesRef.current)
      summariesRef.current = []
    }
  }, [load])

  return { summaries, loading, reload: load }
}
