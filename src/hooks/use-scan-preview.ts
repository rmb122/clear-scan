import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { createRenderCacheKey, isAbortError, scannerClient } from '@/lib/scanner-client'
import type { ScanPage, WatermarkSettings } from '@/lib/types'
import { messages } from '@/lib/i18n'

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

export function useScanPreview(
  page: ScanPage | undefined,
  enabled: boolean,
  watermark?: WatermarkSettings,
) {
  const previewRef = useRef<RenderedPreview | undefined>(undefined)
  const pageRef = useRef(page)
  const options = { ...PREVIEW_RENDER_OPTIONS, watermark }
  const optionsRef = useRef(options)
  const [preview, setPreview] = useState<RenderedPreview>()
  const [rendering, setRendering] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  pageRef.current = page
  optionsRef.current = options

  const renderKey = page ? createRenderCacheKey(page, options) : undefined

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
      toast.dismiss('preview-render-error')
    },
    [],
  )

  useEffect(() => {
    const currentPage = pageRef.current
    const currentOptions = optionsRef.current
    if (!enabled || !currentPage || !renderKey) return
    let cancelled = false
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setRendering(true)
      void scannerClient
        .render(currentPage, currentOptions, {
          intent: 'preview',
          signal: controller.signal,
        })
        .then(({ blob }) => {
          if (cancelled) return
          toast.dismiss('preview-render-error')
          replacePreview({
            pageId: currentPage.id,
            renderKey,
            url: URL.createObjectURL(blob),
            blob,
          })
        })
        .catch((reason: unknown) => {
          if (!cancelled && !isAbortError(reason))
            toast.error(messages.previewFailed, {
              id: 'preview-render-error',
              description: reason instanceof Error ? reason.message : messages.retry,
              action: {
                label: messages.regenerate,
                onClick: () => setRetryVersion((current) => current + 1),
              },
              duration: Infinity,
            })
        })
        .finally(() => !cancelled && setRendering(false))
    }, 220)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [enabled, page?.source, renderKey, replacePreview, retryVersion])

  const activePreview = preview?.pageId === page?.id ? preview : undefined
  const isCurrent = Boolean(activePreview && activePreview.renderKey === renderKey)

  return { preview: activePreview, isCurrent, rendering, clearPreview }
}
