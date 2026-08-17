import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { createRenderCacheKey, isAbortError, scannerClient } from '@/lib/scanner-client'
import type { ScanPage } from '@/lib/types'

interface RenderedPreview {
  pageId: string
  renderKey: string
  url: string
  blob: Blob
}

const PREVIEW_RENDER_OPTIONS = {
  maxEdge: 1400,
  mimeType: 'image/jpeg',
  quality: 0.9,
} as const

export function useScanPreview(page: ScanPage | undefined, enabled: boolean) {
  const previewRef = useRef<RenderedPreview | undefined>(undefined)
  const pageRef = useRef(page)
  const [preview, setPreview] = useState<RenderedPreview>()
  const [rendering, setRendering] = useState(false)
  pageRef.current = page

  const renderKey = page ? createRenderCacheKey(page, PREVIEW_RENDER_OPTIONS) : undefined

  const replacePreview = useCallback((next?: RenderedPreview) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current.url)
    previewRef.current = next
    setPreview(next)
  }, [])

  const clearPreview = useCallback(() => {
    replacePreview()
    setRendering(false)
  }, [replacePreview])

  useEffect(() => {
    if (previewRef.current?.pageId !== page?.id) clearPreview()
  }, [clearPreview, page?.id])

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url)
    },
    [],
  )

  useEffect(() => {
    const currentPage = pageRef.current
    if (!enabled || !currentPage || !renderKey) return
    let cancelled = false
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setRendering(true)
      void scannerClient
        .render(currentPage, PREVIEW_RENDER_OPTIONS, {
          intent: 'preview',
          signal: controller.signal,
        })
        .then(({ blob }) => {
          if (cancelled) return
          replacePreview({
            pageId: currentPage.id,
            renderKey,
            url: URL.createObjectURL(blob),
            blob,
          })
        })
        .catch((reason: unknown) => {
          if (!cancelled && !isAbortError(reason))
            toast.error('预览生成失败', {
              description: reason instanceof Error ? reason.message : '请重试',
            })
        })
        .finally(() => !cancelled && setRendering(false))
    }, 220)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [enabled, page?.source, renderKey, replacePreview])

  const activePreview = preview?.pageId === page?.id ? preview : undefined
  const isCurrent = Boolean(activePreview && activePreview.renderKey === renderKey)

  return { preview: activePreview, isCurrent, rendering, clearPreview }
}
