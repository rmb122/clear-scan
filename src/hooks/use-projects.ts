import { useCallback, useEffect, useState } from 'react'
import { db, getProjectPages } from '@/lib/db'
import type { ScanProject } from '@/lib/types'

export interface ProjectSummary {
  project: ScanProject
  pageCount: number
  thumbnailUrl?: string
}

export function useProjectSummaries(limit?: number) {
  const [summaries, setSummaries] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const projects = await db.projects.orderBy('updatedAt').reverse().toArray()
    const selected = typeof limit === 'number' ? projects.slice(0, limit) : projects
    const next = await Promise.all(
      selected.map(async (project) => {
        const pages = await getProjectPages(project.id)
        const thumbnail = pages[0]?.thumbnail ?? pages[0]?.source
        return {
          project,
          pageCount: pages.length,
          thumbnailUrl: thumbnail ? URL.createObjectURL(thumbnail) : undefined,
        }
      }),
    )
    setSummaries((current) => {
      current.forEach(
        (summary) => summary.thumbnailUrl && URL.revokeObjectURL(summary.thumbnailUrl),
      )
      return next
    })
    setLoading(false)
  }, [limit])

  useEffect(() => {
    void load()
    return () => {
      setSummaries((current) => {
        current.forEach(
          (summary) => summary.thumbnailUrl && URL.revokeObjectURL(summary.thumbnailUrl),
        )
        return []
      })
    }
  }, [load])

  return { summaries, loading, reload: load }
}
