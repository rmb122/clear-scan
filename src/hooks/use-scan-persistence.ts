import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { db, updatePageMetadata } from '@/lib/db'
import type { ScanPage, ScanProject } from '@/lib/types'

export function useScanPersistence(page: ScanPage | undefined, project: ScanProject | undefined) {
  const pageRef = useRef(page)
  const projectRef = useRef(project)

  useEffect(() => {
    pageRef.current = page
    projectRef.current = project
  }, [page, project])

  useEffect(
    () => () => {
      const latestPage = pageRef.current
      const latestProject = projectRef.current
      if (!latestPage || !latestProject) return
      const updatedAt = Date.now()
      void Promise.all([
        updatePageMetadata({ ...latestPage, updatedAt }),
        db.projects.update(latestProject.id, { updatedAt }),
      ]).catch(() => undefined)
    },
    [],
  )

  useEffect(() => {
    if (!page || !project) return
    const timer = window.setTimeout(() => {
      const updatedAt = Date.now()
      void updatePageMetadata({ ...page, updatedAt })
        .then(() => db.projects.update(project.id, { updatedAt }))
        .catch((reason: unknown) => {
          toast.error('自动保存失败', {
            id: 'scan-autosave-error',
            description: reason instanceof Error ? reason.message : '浏览器无法写入本地存储',
          })
        })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [page, project])

  return pageRef
}
