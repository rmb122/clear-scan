import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Crop,
  FileCheck2,
  LoaderCircle,
  RotateCcw,
  ScanLine,
  Sparkles,
} from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { CapturePanel } from '@/components/capture-panel'
import { CropEditor } from '@/components/crop-editor'
import { ExportDialog } from '@/components/export-dialog'
import { FilterPanel } from '@/components/filter-panel'
import { PageRail } from '@/components/page-rail'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  bulkUpdatePageMetadata,
  db,
  getProjectWithPages,
  putPage,
  updatePageMetadata,
  updatePageWithThumbnail,
} from '@/lib/db'
import { DEFAULT_QUAD } from '@/lib/geometry'
import { isAbortError, scannerClient } from '@/lib/scanner-client'
import {
  DEFAULT_ADJUSTMENTS,
  ORIGINAL_EFFECTS,
  SMART_EFFECTS,
  MODE_LABELS,
  type DetectionResult,
  type EnhancementEffect,
  type EnhancementEffects,
  type NormalizedQuad,
  type PageRole,
  type PassportLayout,
  type ScanMode,
  type ScanPage as ScanPageModel,
  type ScanProject,
} from '@/lib/types'
import { cn, createId, modeDefaultName } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'

type EditorStage = 'capture' | 'crop' | 'enhance'

interface RenderedPreview {
  pageId: string
  renderKey: string
  url: string
  blob: Blob
}

function isScanMode(value?: string): value is ScanMode {
  return value === 'id-card' || value === 'passport' || value === 'document'
}

async function fallbackDetection(source: Blob): Promise<DetectionResult> {
  const bitmap = await createImageBitmap(source, {
    imageOrientation: 'from-image',
  })
  const result: DetectionResult = {
    width: bitmap.width,
    height: bitmap.height,
    corners: DEFAULT_QUAD.map((point) => ({ ...point })) as typeof DEFAULT_QUAD,
    confidence: 0,
    cornerSource: 'fallback',
    glareLevel: 'none',
  }
  bitmap.close()
  return result
}

export function ScanPage() {
  const { mode: routeMode, projectId } = useParams()
  const navigate = useNavigate()
  const previewRef = useRef<RenderedPreview | undefined>(undefined)
  const workspaceRef = useRef<HTMLElement | null>(null)
  const [project, setProject] = useState<ScanProject>()
  const [pages, setPages] = useState<ScanPageModel[]>([])
  const [active, setActive] = useState<ScanPageModel>()
  const [stage, setStage] = useState<EditorStage>('capture')
  const [passportLayout, setPassportLayoutState] = useState<PassportLayout>('data-page')
  const [busy, setBusy] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [sourceUrl, setSourceUrl] = useState<string>()
  const [preview, setPreview] = useState<RenderedPreview>()
  const activeRef = useRef<ScanPageModel | undefined>(undefined)
  const projectRef = useRef<ScanProject | undefined>(undefined)
  const engineProgress = useAppStore((state) => state.engineProgress)
  const engineLabel = useAppStore((state) => state.engineLabel)
  const activeSource = active?.source
  const activePageId = active?.id
  const activeRenderKey = useMemo(
    () =>
      active
        ? JSON.stringify([active.id, active.corners, active.rotation, active.effects, active.adjustments])
        : undefined,
    [active],
  )
  const activePreview = preview?.pageId === activePageId ? preview : undefined
  const previewIsCurrent = Boolean(activePreview && activeRenderKey && activePreview.renderKey === activeRenderKey)
  const updateCropCorners = useCallback(
    (corners: NormalizedQuad) => {
      setActive((current) =>
        current && current.id === activePageId
          ? {
              ...current,
              corners,
              cornerSource: 'manual',
              cropConfirmed: false,
              updatedAt: Date.now(),
            }
          : current,
      )
    },
    [activePageId],
  )

  const mode: ScanMode = project?.mode ?? (isScanMode(routeMode) ? routeMode : 'document')
  const sortedPages = useMemo(() => [...pages].sort((a, b) => a.order - b.order), [pages])
  const effectivePages = useMemo(
    () => sortedPages.map((page) => (page.id === active?.id ? active : page)),
    [active, sortedPages],
  )
  const nextRole: PageRole =
    mode === 'id-card' ? (pages.some((page) => page.role === 'front') ? 'back' : 'front') : 'page'

  useEffect(() => {
    void scannerClient.prewarm().catch(() => undefined)
  }, [])

  useEffect(() => {
    activeRef.current = active
    projectRef.current = project
  }, [active, project])

  useEffect(
    () => () => {
      const latestPage = activeRef.current
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
    if (stage === 'capture' || !activePageId || window.matchMedia('(min-width: 1024px)').matches) return
    const frame = window.requestAnimationFrame(() => {
      workspaceRef.current?.scrollIntoView({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activePageId, stage])

  useEffect(() => {
    if (projectId) {
      let cancelled = false
      void getProjectWithPages(projectId)
        .then(({ project: storedProject, pages: storedPages }) => {
          if (cancelled) return
          if (!storedProject) {
            toast.error('找不到这个扫描项目')
            navigate('/history', { replace: true })
            return
          }
          setProject(storedProject)
          setPages(storedPages)
          setPassportLayoutState(storedProject.passportLayout ?? 'data-page')
          if (storedPages.length) {
            setActive(storedPages[0])
            setStage(storedPages[0].cropConfirmed ? 'enhance' : 'crop')
          } else {
            setStage('capture')
          }
        })
        .catch((reason: unknown) => {
          if (cancelled) return
          toast.error('扫描项目读取失败', {
            description: reason instanceof Error ? reason.message : '浏览器无法读取本地存储',
          })
          navigate('/history', { replace: true })
        })
      return () => {
        cancelled = true
      }
    }
    setProject(undefined)
    setPages([])
    setActive(undefined)
    setStage('capture')
    setPassportLayoutState('data-page')
  }, [navigate, projectId, routeMode])

  useEffect(() => {
    if (!activeSource) {
      setSourceUrl(undefined)
      return
    }
    const url = URL.createObjectURL(activeSource)
    setSourceUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [activeSource])

  const replacePreview = useCallback((next?: RenderedPreview) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current.url)
    previewRef.current = next
    setPreview(next)
  }, [])

  useEffect(() => {
    if (previewRef.current?.pageId !== activePageId) replacePreview()
    setRendering(false)
  }, [activePageId, replacePreview])

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url)
    },
    [],
  )

  useEffect(() => {
    const page = activeRef.current
    if (!page || !activeRenderKey || stage !== 'enhance') return
    let cancelled = false
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setRendering(true)
      void scannerClient
        .render(
          page,
          { maxEdge: 1400, mimeType: 'image/jpeg', quality: 0.9 },
          { intent: 'preview', signal: controller.signal },
        )
        .then(({ blob }) => {
          if (cancelled) return
          replacePreview({
            pageId: page.id,
            renderKey: activeRenderKey,
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
  }, [activeRenderKey, activeSource, replacePreview, stage])

  useEffect(() => {
    if (!active || !project) return
    const timer = window.setTimeout(() => {
      void updatePageMetadata({ ...active, updatedAt: Date.now() })
        .then(() => db.projects.update(project.id, { updatedAt: Date.now() }))
        .catch((reason: unknown) => {
          toast.error('自动保存失败', {
            id: 'scan-autosave-error',
            description: reason instanceof Error ? reason.message : '浏览器无法写入本地存储',
          })
        })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [active, project])

  const ensureProject = async () => {
    if (project) return project
    const now = Date.now()
    const created: ScanProject = {
      id: createId(),
      mode,
      name: modeDefaultName(mode),
      passportLayout: mode === 'passport' ? passportLayout : undefined,
      createdAt: now,
      updatedAt: now,
    }
    await db.projects.put(created)
    setProject(created)
    navigate(`/project/${created.id}`, { replace: true })
    return created
  }

  const processFiles = async (files: File[]) => {
    if (!files.length || busy) return
    setBusy(true)
    try {
      const currentProject = await ensureProject()
      const workingPages = [...pages]
      const added: ScanPageModel[] = []
      for (const file of files) {
        if (mode === 'id-card' && workingPages.length >= 2) break
        let detection: DetectionResult
        try {
          detection = await scannerClient.detect(file, mode, passportLayout)
        } catch (reason) {
          detection = await fallbackDetection(file)
          toast.warning('没有可靠识别到文档边缘', {
            description: reason instanceof Error ? `${reason.message}，请手动调整四角。` : '请手动调整四角。',
          })
        }
        const role: PageRole =
          mode === 'id-card' ? (workingPages.some((page) => page.role === 'front') ? 'back' : 'front') : 'page'
        const now = Date.now()
        const page: ScanPageModel = {
          id: createId(),
          projectId: currentProject.id,
          order: workingPages.length,
          role,
          source: file,
          sourceName: file.name,
          width: detection.width,
          height: detection.height,
          corners: detection.corners,
          confidence: detection.confidence,
          cornerSource: detection.cornerSource,
          cropConfirmed: false,
          glareLevel: detection.glareLevel,
          rotation: 0,
          effects: { ...SMART_EFFECTS },
          adjustments: { ...DEFAULT_ADJUSTMENTS },
          createdAt: now,
          updatedAt: now,
        }
        workingPages.push(page)
        added.push(page)
        await putPage(page)
      }
      await db.projects.update(currentProject.id, {
        updatedAt: Date.now(),
        passportLayout,
      })
      setPages(workingPages)
      if (added[0]) {
        setActive(added[0])
        setStage('crop')
      }
    } catch (reason) {
      toast.error('无法添加照片', {
        description: reason instanceof Error ? reason.message : '请换一张图片重试',
      })
    } finally {
      setBusy(false)
    }
  }

  const saveActive = async () => {
    if (!active || !project) return
    const currentThumbnail = previewIsCurrent && activePreview ? activePreview.blob : undefined
    const saved = {
      ...active,
      thumbnail: currentThumbnail ?? active.thumbnail,
      updatedAt: Date.now(),
    }
    if (currentThumbnail) await updatePageWithThumbnail(saved, currentThumbnail)
    else await updatePageMetadata(saved)
    await db.projects.update(project.id, { updatedAt: Date.now() })
    const nextPages = effectivePages.map((page) => (page.id === saved.id ? saved : page))
    setPages(nextPages)
    setActive(saved)
    toast.success('页面已保存到本地')
    if (mode === 'id-card' && !nextPages.some((page) => page.role === (saved.role === 'front' ? 'back' : 'front'))) {
      setActive(undefined)
      setStage('capture')
      toast('请继续拍摄身份证另一面')
    }
  }

  const setPassportLayout = async (layout: PassportLayout) => {
    setPassportLayoutState(layout)
    if (project) {
      const updated = {
        ...project,
        passportLayout: layout,
        updatedAt: Date.now(),
      }
      setProject(updated)
      await db.projects.put(updated)
    }
  }

  const renameProject = (name: string) => {
    if (!project) return
    const updated = { ...project, name, updatedAt: Date.now() }
    setProject(updated)
    void db.projects.put(updated)
  }

  const deletePage = async (page: ScanPageModel) => {
    if (
      !window.confirm(
        `确定删除${mode === 'id-card' ? (page.role === 'front' ? '人像面' : '国徽面') : `第 ${page.order + 1} 页`}？`,
      )
    )
      return
    await db.pages.delete(page.id)
    scannerClient.invalidatePage(page.id)
    const remaining = effectivePages
      .filter((item) => item.id !== page.id)
      .sort((a, b) => a.order - b.order)
      .map((item, index) => ({ ...item, order: index }))
    await bulkUpdatePageMetadata(remaining)
    setPages(remaining)
    if (active?.id === page.id) {
      setActive(remaining[0])
      setStage(remaining.length ? (remaining[0].cropConfirmed ? 'enhance' : 'crop') : 'capture')
    }
    toast.success('页面已删除')
  }

  const movePage = async (page: ScanPageModel, direction: -1 | 1) => {
    const ordered = [...effectivePages]
    const index = ordered.findIndex((item) => item.id === page.id)
    const target = index + direction
    if (target < 0 || target >= ordered.length) return
    ;[ordered[index], ordered[target]] = [ordered[target], ordered[index]]
    const reordered = ordered.map((item, order) => ({
      ...item,
      order,
      updatedAt: Date.now(),
    }))
    await bulkUpdatePageMetadata(reordered)
    setPages(reordered)
    setActive((current) => (current ? reordered.find((item) => item.id === current.id) : current))
  }

  const redetect = async () => {
    if (!active) return
    const pageId = active.id
    setBusy(true)
    try {
      const detection = await scannerClient.detect(active.source, mode, passportLayout)
      if (activeRef.current?.id !== pageId) return
      setActive((current) =>
        current?.id === pageId ? { ...current, ...detection, cropConfirmed: false, updatedAt: Date.now() } : current,
      )
      toast.success('已重新识别边缘')
    } catch (reason) {
      toast.error('重新识别失败', {
        description: reason instanceof Error ? reason.message : '请手动调整四角',
      })
    } finally {
      setBusy(false)
    }
  }

  const flushActivePage = () => {
    if (!active) return effectivePages
    const saved = { ...active, updatedAt: Date.now() }
    const nextPages = effectivePages.map((page) => (page.id === saved.id ? saved : page))
    setPages(nextPages)
    void updatePageMetadata(saved)
      .then(() => (project ? db.projects.update(project.id, { updatedAt: saved.updatedAt }) : undefined))
      .catch((reason: unknown) => {
        toast.error('页面保存失败', {
          id: 'scan-flush-error',
          description: reason instanceof Error ? reason.message : '浏览器无法写入本地存储',
        })
      })
    return nextPages
  }

  const selectPage = (page: ScanPageModel) => {
    const nextPages = flushActivePage()
    const selected = nextPages.find((item) => item.id === page.id) ?? page
    setActive(selected)
    setStage(selected.cropConfirmed ? 'enhance' : 'crop')
  }

  const startCapture = () => {
    flushActivePage()
    setActive(undefined)
    setStage('capture')
  }

  const changeEffect = (category: keyof EnhancementEffects, effect: EnhancementEffect) => {
    if (!active) return
    setActive((current) =>
      current?.id === active.id
        ? {
            ...current,
            effects: {
              ...current.effects,
              [category]: effect,
            } as EnhancementEffects,
            updatedAt: Date.now(),
          }
        : current,
    )
  }

  const applyEffectPreset = (preset: 'original' | 'smart') => {
    if (!active) return
    setActive({
      ...active,
      effects: {
        ...(preset === 'original' ? ORIGINAL_EFFECTS : SMART_EFFECTS),
      },
      adjustments: { ...DEFAULT_ADJUSTMENTS },
      updatedAt: Date.now(),
    })
  }

  const confirmCrop = () => {
    if (!active) return
    const confirmed = { ...active, cropConfirmed: true, updatedAt: Date.now() }
    setActive(confirmed)
    void updatePageMetadata(confirmed).catch((reason: unknown) => {
      if (activeRef.current?.id === confirmed.id) {
        replacePreview()
        setActive((current) => (current?.id === confirmed.id ? { ...current, cropConfirmed: false } : current))
        setStage('crop')
      }
      toast.error('裁剪确认保存失败', {
        id: 'crop-confirmation-save-error',
        description: reason instanceof Error ? reason.message : '浏览器无法写入本地存储',
      })
    })
    setStage('enhance')
  }

  const reopenCrop = () => {
    if (!active) return
    const unconfirmed = { ...active, cropConfirmed: false, updatedAt: Date.now() }
    replacePreview()
    setRendering(false)
    setActive(unconfirmed)
    void updatePageMetadata(unconfirmed).catch((reason: unknown) => {
      toast.error('裁剪状态保存失败', {
        id: 'crop-confirmation-save-error',
        description: reason instanceof Error ? reason.message : '浏览器无法写入本地存储',
      })
    })
    setStage('crop')
  }

  return (
    <div className="min-h-[calc(100svh-4rem)] bg-background lg:flex lg:h-[calc(100dvh-4rem)] lg:min-h-0 lg:flex-col">
      <div className="border-b border-border/80 bg-card lg:shrink-0">
        <div className="mx-auto max-w-[1480px] px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate('/')} aria-label="返回首页">
                <ArrowLeft />
              </Button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{MODE_LABELS[mode]}</Badge>
                  <span className="text-[10px] font-semibold text-muted-foreground">{effectivePages.length} 页</span>
                </div>
                {project ? (
                  <input
                    value={project.name}
                    onChange={(event) => renameProject(event.target.value)}
                    className="-ml-2 mt-1 h-9 max-w-[15rem] truncate rounded-lg bg-transparent px-2 text-sm font-bold outline-none transition focus:bg-muted focus:text-primary sm:max-w-md"
                    aria-label="项目名称"
                  />
                ) : (
                  <h1 className="mt-1 text-sm font-bold">新建{MODE_LABELS[mode]}</h1>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {project && <ExportDialog project={project} pages={effectivePages} />}
            </div>
          </div>
        </div>
      </div>

      <div className="border-b border-border/80 bg-background lg:shrink-0">
        <div className="mx-auto max-w-[1480px] px-4 py-2.5 sm:px-6">
          <div className="mx-auto flex max-w-xl items-center justify-between text-[10px] font-semibold text-muted-foreground">
            {[
              { key: 'capture', label: '拍照或上传', icon: ScanLine },
              { key: 'crop', label: '确认边缘', icon: Crop },
              { key: 'enhance', label: '增强与导出', icon: Sparkles },
            ].map((step, index) => (
              <div key={step.key} className="contents">
                <span className={cn('flex items-center gap-1.5', stage === step.key && 'text-primary')}>
                  <span
                    className={cn(
                      'grid size-6 place-items-center rounded-full bg-muted',
                      stage === step.key && 'bg-primary text-white',
                    )}
                  >
                    <step.icon className="size-3" />
                  </span>
                  {step.label}
                </span>
                {index < 2 && <ChevronRight className="size-3 text-border" />}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-card lg:min-h-0 lg:flex-1">
        <div className="mx-auto max-w-[1480px] lg:grid lg:h-full lg:grid-cols-[132px_minmax(0,1fr)_340px]">
          <aside className="hidden border-r border-border bg-card lg:block lg:h-full">
            <PageRail
              mode={mode}
              pages={effectivePages}
              activeId={active?.id}
              onSelect={selectPage}
              onAdd={startCapture}
              onDelete={(page) => void deletePage(page)}
              onMove={(page, direction) => void movePage(page, direction)}
            />
          </aside>
          {effectivePages.length > 0 && (
            <div className="border-b border-border bg-card lg:hidden">
              <PageRail
                mode={mode}
                pages={effectivePages}
                activeId={active?.id}
                onSelect={selectPage}
                onAdd={startCapture}
                onDelete={(page) => void deletePage(page)}
                onMove={(page, direction) => void movePage(page, direction)}
              />
            </div>
          )}

          {stage === 'capture' ? (
            <div className="lg:col-span-2 lg:min-h-0 lg:overflow-y-auto">
              <CapturePanel
                mode={mode}
                passportLayout={passportLayout}
                nextRole={nextRole}
                busy={busy}
                onPassportLayoutChange={(layout) => void setPassportLayout(layout)}
                onFiles={(files) => void processFiles(files)}
              />
              {busy && (
                <div className="fixed inset-0 z-50 grid place-items-center bg-[#081711]/55 p-6 backdrop-blur-sm">
                  <div className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl">
                    <div className="flex items-center gap-3">
                      <LoaderCircle className="size-5 animate-spin text-primary" />
                      <div>
                        <p className="text-sm font-bold">正在处理照片</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{engineLabel}</p>
                      </div>
                    </div>
                    <Progress value={engineProgress} className="mt-4" />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <section
                ref={workspaceRef}
                className="paper-grid relative min-h-[480px] scroll-mt-16 overflow-hidden lg:h-full lg:min-h-0"
              >
                {stage === 'crop' && active && sourceUrl && (
                  <CropEditor
                    sourceUrl={sourceUrl}
                    width={active.width}
                    height={active.height}
                    corners={active.corners}
                    cornerSource={active.cornerSource}
                    onChange={updateCropCorners}
                  />
                )}
                {stage === 'enhance' &&
                  active &&
                  (activePreview ? (
                    <div className="flex size-full items-center justify-center p-4 sm:p-8">
                      <img
                        src={activePreview.url}
                        alt="扫描增强预览"
                        className={cn(
                          'max-h-full max-w-full object-contain shadow-[0_20px_65px_rgba(0,0,0,.5)] transition-opacity',
                          (rendering || !previewIsCurrent) && 'opacity-55',
                        )}
                      />
                    </div>
                  ) : (
                    <div className="absolute inset-0 grid place-items-center p-4" role="status" aria-live="polite">
                      <div className="flex flex-col items-center gap-3 text-white/75">
                        <LoaderCircle className="size-8 animate-spin" />
                        <span className="text-xs font-semibold">正在生成增强预览</span>
                      </div>
                    </div>
                  ))}
                {(rendering || !previewIsCurrent) && activePreview && (
                  <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-[10px] font-semibold text-white backdrop-blur">
                    <LoaderCircle className="size-3 animate-spin" />
                    正在更新效果
                  </div>
                )}
              </section>

              <aside className="border-t border-border bg-card p-5 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:p-6">
                {stage === 'crop' && active && (
                  <div className="space-y-5">
                    <div>
                      <Badge
                        variant={
                          active.cornerSource === 'detected' || active.cornerSource === 'manual' ? 'default' : 'warning'
                        }
                      >
                        {active.cornerSource === 'detected'
                          ? '预识别结果待确认'
                          : active.cornerSource === 'manual'
                            ? '已手动调整，等待确认'
                            : active.cornerSource === 'fallback'
                              ? '需要手动调整'
                              : '需要人工确认'}
                      </Badge>
                      <h2 className="mt-3 text-xl font-bold">确认四个角点</h2>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        拖动边框外侧的绿色圆柄，让短线所指的角点贴合证件或纸张；拖动时可通过放大镜精确对齐。
                      </p>
                    </div>
                    <div className="rounded-2xl bg-muted p-4 text-xs leading-5 text-muted-foreground">
                      <p className="font-bold text-foreground">裁剪小技巧</p>
                      <ul className="mt-2 space-y-1.5">
                        <li>· 边缘宁可稍微向内，不要带入桌面背景</li>
                        <li>· 护照展开双页应包含完整装订线</li>
                        <li>· 旋转可以在下一步继续调整</li>
                      </ul>
                    </div>
                    <Button variant="outline" className="w-full" disabled={busy} onClick={() => void redetect()}>
                      <RotateCcw />
                      重新识别
                    </Button>
                    <Button size="lg" className="w-full" onClick={confirmCrop}>
                      <Check />
                      确认裁剪
                    </Button>
                  </div>
                )}
                {stage === 'enhance' && active && (
                  <div>
                    <div className="mb-6">
                      <h2 className="text-xl font-bold">调整扫描效果</h2>
                      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                        不同分类可以叠加，同一分类始终只保留一个效果。
                      </p>
                    </div>
                    <FilterPanel
                      effects={active.effects}
                      adjustments={active.adjustments}
                      glareLevel={active.glareLevel}
                      onEffectChange={changeEffect}
                      onPresetApply={applyEffectPreset}
                      onAdjustmentsChange={(adjustments) =>
                        setActive({
                          ...active,
                          adjustments,
                          updatedAt: Date.now(),
                        })
                      }
                      onRotate={(direction) =>
                        setActive((current) =>
                          current?.id === active.id
                            ? {
                                ...current,
                                rotation: ((current.rotation + (direction === 'clockwise' ? 90 : 270)) %
                                  360) as ScanPageModel['rotation'],
                                updatedAt: Date.now(),
                              }
                            : current,
                        )
                      }
                    />
                    <div className="mt-6 grid grid-cols-2 gap-2">
                      <Button variant="outline" onClick={reopenCrop}>
                        <Crop />
                        调整边缘
                      </Button>
                      <Button disabled={!previewIsCurrent || rendering} onClick={() => void saveActive()}>
                        <FileCheck2 />
                        保存页面
                      </Button>
                    </div>
                  </div>
                )}
              </aside>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
