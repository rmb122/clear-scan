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
import { bulkPutPages, db, getProjectWithPages, putPage } from '@/lib/db'
import {
  hasUsableAdvancedCorrection,
  prepareInstalledAdvancedModel,
} from '@/lib/advanced-model'
import { DETECTION_CONFIDENCE_THRESHOLD } from '@/lib/document-detection'
import { DEFAULT_QUAD } from '@/lib/geometry'
import { scannerClient } from '@/lib/scanner-client'
import {
  DEFAULT_ADJUSTMENTS,
  MODE_LABELS,
  type DetectionResult,
  type FilterPreset,
  type PageRole,
  type PassportLayout,
  type ScanMode,
  type ScanPage as ScanPageModel,
  type ScanProject,
} from '@/lib/types'
import { cn, createId, modeDefaultName } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'

type EditorStage = 'capture' | 'crop' | 'enhance'

function isScanMode(value?: string): value is ScanMode {
  return value === 'id-card' || value === 'passport' || value === 'document'
}

async function fallbackDetection(source: Blob): Promise<DetectionResult> {
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' })
  const result: DetectionResult = {
    width: bitmap.width,
    height: bitmap.height,
    corners: DEFAULT_QUAD.map((point) => ({ ...point })) as typeof DEFAULT_QUAD,
    confidence: 0,
    glareLevel: 'none',
  }
  bitmap.close()
  return result
}

export function ScanPage() {
  const { mode: routeMode, projectId } = useParams()
  const navigate = useNavigate()
  const loadedProjectId = useRef<string | undefined>(undefined)
  const previewUrlRef = useRef<string | undefined>(undefined)
  const [project, setProject] = useState<ScanProject>()
  const [pages, setPages] = useState<ScanPageModel[]>([])
  const [active, setActive] = useState<ScanPageModel>()
  const [stage, setStage] = useState<EditorStage>('capture')
  const [passportLayout, setPassportLayoutState] = useState<PassportLayout>('data-page')
  const [busy, setBusy] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [sourceUrl, setSourceUrl] = useState<string>()
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [previewBlob, setPreviewBlob] = useState<Blob>()
  const engineProgress = useAppStore((state) => state.engineProgress)
  const engineLabel = useAppStore((state) => state.engineLabel)
  const modelState = useAppStore((state) => state.modelState)
  const activeSource = active?.source

  const mode: ScanMode = project?.mode ?? (isScanMode(routeMode) ? routeMode : 'document')
  const sortedPages = useMemo(() => [...pages].sort((a, b) => a.order - b.order), [pages])
  const nextRole: PageRole =
    mode === 'id-card'
      ? pages.some((page) => page.role === 'front')
        ? 'back'
        : 'front'
      : 'page'

  useEffect(() => {
    if (projectId) {
      if (loadedProjectId.current === projectId) return
      loadedProjectId.current = projectId
      void getProjectWithPages(projectId).then(({ project: storedProject, pages: storedPages }) => {
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
          setStage('enhance')
        } else {
          setStage('capture')
        }
      })
      return
    }
    loadedProjectId.current = undefined
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

  const replacePreview = useCallback((url?: string, blob?: Blob) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = url
    setPreviewUrl(url)
    setPreviewBlob(blob)
  }, [])

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  useEffect(() => {
    if (!active || stage !== 'enhance') return
    let cancelled = false
    const timer = window.setTimeout(() => {
      setRendering(true)
      void scannerClient
        .render(active, { maxEdge: 1400, mimeType: 'image/jpeg', quality: 0.9 })
        .then(({ blob, correction }) => {
          if (cancelled) return
          replacePreview(URL.createObjectURL(blob), blob)
          if (
            correction &&
            active.advancedCorrection?.fingerprint !== correction.fingerprint
          ) {
            setActive((current) => current?.id === active.id
              ? { ...current, advancedCorrection: correction, updatedAt: Date.now() }
              : current)
            setPages((current) => current.map((page) => page.id === active.id
              ? { ...page, advancedCorrection: correction, updatedAt: Date.now() }
              : page))
          }
        })
        .catch((reason: unknown) => {
          if (!cancelled) toast.error('预览生成失败', { description: reason instanceof Error ? reason.message : '请重试' })
        })
        .finally(() => !cancelled && setRendering(false))
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, replacePreview, stage])

  useEffect(() => {
    if (!active || !project) return
    const timer = window.setTimeout(() => {
      void putPage({ ...active, updatedAt: Date.now() })
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
    loadedProjectId.current = created.id
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
          mode === 'id-card'
            ? workingPages.some((page) => page.role === 'front')
              ? 'back'
              : 'front'
            : 'page'
        const now = Date.now()
        let page: ScanPageModel = {
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
          glareLevel: detection.glareLevel,
          rotation: 0,
          filter: 'smart',
          adjustments: { ...DEFAULT_ADJUSTMENTS },
          createdAt: now,
          updatedAt: now,
        }
        try {
          const thumbnail = await scannerClient.render(page, { maxEdge: 560, mimeType: 'image/jpeg', quality: 0.76 })
          page = { ...page, thumbnail: thumbnail.blob }
        } catch {
          page = { ...page, thumbnail: file }
        }
        workingPages.push(page)
        added.push(page)
        await putPage(page)
      }
      await db.projects.update(currentProject.id, { updatedAt: Date.now(), passportLayout })
      setPages(workingPages)
      if (added[0]) {
        replacePreview(undefined, undefined)
        setActive(added[0])
        setStage('crop')
      }
    } catch (reason) {
      toast.error('无法添加照片', { description: reason instanceof Error ? reason.message : '请换一张图片重试' })
    } finally {
      setBusy(false)
    }
  }

  const saveActive = async () => {
    if (!active || !project) return
    const saved = { ...active, thumbnail: previewBlob ?? active.thumbnail, updatedAt: Date.now() }
    await putPage(saved)
    await db.projects.update(project.id, { updatedAt: Date.now() })
    const nextPages = pages.map((page) => (page.id === saved.id ? saved : page))
    setPages(nextPages)
    setActive(saved)
    toast.success('页面已保存到本地')
    if (mode === 'id-card' && !nextPages.some((page) => page.role === (saved.role === 'front' ? 'back' : 'front'))) {
      setActive(undefined)
      replacePreview(undefined, undefined)
      setStage('capture')
      toast('请继续拍摄身份证另一面')
    }
  }

  const setPassportLayout = async (layout: PassportLayout) => {
    setPassportLayoutState(layout)
    if (project) {
      const updated = { ...project, passportLayout: layout, updatedAt: Date.now() }
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
    if (!window.confirm(`确定删除${mode === 'id-card' ? page.role === 'front' ? '人像面' : '国徽面' : `第 ${page.order + 1} 页`}？`)) return
    await db.pages.delete(page.id)
    const remaining = pages.filter((item) => item.id !== page.id).sort((a, b) => a.order - b.order).map((item, index) => ({ ...item, order: index }))
    await bulkPutPages(remaining)
    setPages(remaining)
    if (active?.id === page.id) {
      setActive(remaining[0])
      setStage(remaining.length ? 'enhance' : 'capture')
    }
    toast.success('页面已删除')
  }

  const movePage = async (page: ScanPageModel, direction: -1 | 1) => {
    const ordered = [...sortedPages]
    const index = ordered.findIndex((item) => item.id === page.id)
    const target = index + direction
    if (target < 0 || target >= ordered.length) return
    ;[ordered[index], ordered[target]] = [ordered[target], ordered[index]]
    const reordered = ordered.map((item, order) => ({ ...item, order, updatedAt: Date.now() }))
    await bulkPutPages(reordered)
    setPages(reordered)
    setActive((current) => current ? reordered.find((item) => item.id === current.id) : current)
  }

  const redetect = async () => {
    if (!active) return
    setBusy(true)
    try {
      const detection = await scannerClient.detect(active.source, mode, passportLayout)
      setActive({ ...active, ...detection, advancedCorrection: undefined, updatedAt: Date.now() })
      toast.success('已重新识别边缘')
    } catch (reason) {
      toast.error('重新识别失败', { description: reason instanceof Error ? reason.message : '请手动调整四角' })
    } finally {
      setBusy(false)
    }
  }

  const selectPage = (page: ScanPageModel) => {
    replacePreview(undefined, undefined)
    setActive(page)
    setStage('enhance')
  }

  const changeFilter = async (filter: FilterPreset) => {
    if (!active) return
    if (filter === 'ai-deshadow' && !hasUsableAdvancedCorrection(active)) {
      if (modelState !== 'ready') {
        toast('需要安装高级去阴影模型', {
          description: '标准“去阴影”无需安装，也可以直接使用。',
        })
        navigate('/settings')
        return
      }
      setRendering(true)
      try {
        await prepareInstalledAdvancedModel()
      } catch (reason) {
        toast.error('高级模型启动失败', {
          description: reason instanceof Error ? reason.message : '请前往设置重试',
        })
        return
      } finally {
        setRendering(false)
      }
    }
    setActive({ ...active, filter, updatedAt: Date.now() })
  }

  return (
    <div className="min-h-[calc(100svh-4rem)] bg-background">
      <div className="border-b border-border/80 bg-card">
        <div className="mx-auto max-w-[1480px] px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate('/')} aria-label="返回首页"><ArrowLeft /></Button>
              <div className="min-w-0">
                <div className="flex items-center gap-2"><Badge variant="secondary">{MODE_LABELS[mode]}</Badge><span className="text-[10px] font-semibold text-muted-foreground">{pages.length} 页</span></div>
                {project ? <input value={project.name} onChange={(event) => renameProject(event.target.value)} className="mt-1 h-6 max-w-[15rem] truncate bg-transparent text-sm font-bold outline-none focus:text-primary sm:max-w-md" aria-label="项目名称" /> : <h1 className="mt-1 text-sm font-bold">新建{MODE_LABELS[mode]}</h1>}
              </div>
            </div>
            <div className="flex items-center gap-2">{project && <ExportDialog project={project} pages={pages} />}</div>
          </div>
        </div>
      </div>

      <div className="border-b border-border/80 bg-background">
        <div className="mx-auto max-w-[1480px] px-4 py-2.5 sm:px-6">
          <div className="mx-auto flex max-w-xl items-center justify-between text-[10px] font-semibold text-muted-foreground">
            {[{ key: 'capture', label: '拍照或上传', icon: ScanLine }, { key: 'crop', label: '确认边缘', icon: Crop }, { key: 'enhance', label: '增强与导出', icon: Sparkles }].map((step, index) => <div key={step.key} className="contents"><span className={cn('flex items-center gap-1.5', stage === step.key && 'text-primary')}><span className={cn('grid size-6 place-items-center rounded-full bg-muted', stage === step.key && 'bg-primary text-white')}><step.icon className="size-3" /></span>{step.label}</span>{index < 2 && <ChevronRight className="size-3 text-border" />}</div>)}
          </div>
        </div>
      </div>

      <div className="bg-card">
        <div className="mx-auto max-w-[1480px] lg:grid lg:grid-cols-[132px_minmax(0,1fr)_340px]">
        <aside className="hidden border-r border-border bg-card lg:block lg:h-[calc(100svh-9.55rem)]"><PageRail mode={mode} pages={pages} activeId={active?.id} onSelect={selectPage} onAdd={() => { setActive(undefined); setStage('capture') }} onDelete={(page) => void deletePage(page)} onMove={(page, direction) => void movePage(page, direction)} /></aside>
        {pages.length > 0 && <div className="border-b border-border bg-card lg:hidden"><PageRail mode={mode} pages={pages} activeId={active?.id} onSelect={selectPage} onAdd={() => { setActive(undefined); setStage('capture') }} onDelete={(page) => void deletePage(page)} onMove={(page, direction) => void movePage(page, direction)} /></div>}

        {stage === 'capture' ? (
          <div className="lg:col-span-2 lg:min-h-[calc(100svh-9.55rem)]">
            <CapturePanel mode={mode} passportLayout={passportLayout} nextRole={nextRole} busy={busy} onPassportLayoutChange={(layout) => void setPassportLayout(layout)} onFiles={(files) => void processFiles(files)} />
            {busy && <div className="fixed inset-0 z-50 grid place-items-center bg-[#081711]/55 p-6 backdrop-blur-sm"><div className="w-full max-w-sm rounded-3xl bg-background p-6 shadow-2xl"><div className="flex items-center gap-3"><LoaderCircle className="size-5 animate-spin text-primary" /><div><p className="text-sm font-bold">正在处理照片</p><p className="mt-0.5 text-xs text-muted-foreground">{engineLabel}</p></div></div><Progress value={engineProgress} className="mt-4" /></div></div>}
          </div>
        ) : (
          <>
            <section className="paper-grid relative min-h-[480px] overflow-hidden lg:h-[calc(100svh-9.55rem)]">
              {stage === 'crop' && active && sourceUrl && <CropEditor sourceUrl={sourceUrl} width={active.width} height={active.height} corners={active.corners} confidence={active.confidence} onChange={(corners) => setActive({ ...active, corners, confidence: 1, advancedCorrection: undefined, updatedAt: Date.now() })} />}
              {stage === 'enhance' && active && <div className="flex size-full items-center justify-center p-4 sm:p-8">{previewUrl ? <img src={previewUrl} alt="扫描增强预览" className={cn('max-h-full max-w-full object-contain shadow-[0_20px_65px_rgba(0,0,0,.5)] transition-opacity', rendering && 'opacity-55')} /> : <div className="flex flex-col items-center gap-3 text-white/75"><LoaderCircle className="size-8 animate-spin" /><span className="text-xs font-semibold">正在生成增强预览</span></div>}</div>}
              {rendering && previewUrl && <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-[10px] font-semibold text-white backdrop-blur"><LoaderCircle className="size-3 animate-spin" />正在更新效果</div>}
            </section>

            <aside className="border-t border-border bg-card p-5 lg:h-[calc(100svh-9.55rem)] lg:overflow-y-auto lg:border-l lg:border-t-0 lg:p-6">
              {stage === 'crop' && active && <div className="space-y-5"><div><Badge>{active.confidence >= DETECTION_CONFIDENCE_THRESHOLD ? '自动识别完成' : '需要手动确认'}</Badge><h2 className="mt-3 text-xl font-bold">确认四个角点</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">拖动绿色圆点，让边框贴合证件或纸张。低对比背景下自动结果可能需要微调。</p></div><div className="rounded-2xl bg-muted p-4 text-xs leading-5 text-muted-foreground"><p className="font-bold text-foreground">裁剪小技巧</p><ul className="mt-2 space-y-1.5"><li>· 边缘宁可稍微向内，不要带入桌面背景</li><li>· 护照展开双页应包含完整装订线</li><li>· 旋转可以在下一步继续调整</li></ul></div><Button variant="outline" className="w-full" disabled={busy} onClick={() => void redetect()}><RotateCcw />重新识别</Button><Button size="lg" className="w-full" onClick={() => setStage('enhance')}><Check />确认裁剪</Button></div>}
              {stage === 'enhance' && active && <div><div className="mb-6"><h2 className="text-xl font-bold">调整扫描效果</h2><p className="mt-1.5 text-sm leading-6 text-muted-foreground">默认使用智能增强，可随时切换回原版。</p></div><FilterPanel filter={active.filter} adjustments={active.adjustments} glareLevel={active.glareLevel} advancedReady={modelState === 'ready' || hasUsableAdvancedCorrection(active)} onAdvancedRequired={() => { toast('请先安装高级去阴影模型'); navigate('/settings') }} onFilterChange={(filter) => void changeFilter(filter)} onAdjustmentsChange={(adjustments) => setActive({ ...active, adjustments, updatedAt: Date.now() })} onRotate={() => setActive({ ...active, rotation: ((active.rotation + 90) % 360) as ScanPageModel['rotation'], advancedCorrection: undefined, updatedAt: Date.now() })} /><div className="mt-6 grid grid-cols-2 gap-2"><Button variant="outline" onClick={() => setStage('crop')}><Crop />调整边缘</Button><Button onClick={() => void saveActive()}><FileCheck2 />保存页面</Button></div></div>}
            </aside>
          </>
        )}
        </div>
      </div>
    </div>
  )
}
