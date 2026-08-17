import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ScanCaptureWorkspace, ScanEditorWorkspace } from '@/components/scan-page-workspaces'
import {
  ScanDeleteDialog,
  ScanPageHeader,
  ScanPageNavigation,
  ScanStageNavigation,
  type ScanStage,
} from '@/components/scan-page-view'
import { useScanPersistence } from '@/hooks/use-scan-persistence'
import { useScanPreview } from '@/hooks/use-scan-preview'
import {
  bulkUpdatePageMetadata,
  db,
  getProjectWithPages,
  putPage,
  updatePageMetadata,
  updatePageWithThumbnail,
} from '@/lib/db'
import { DEFAULT_QUAD } from '@/lib/geometry'
import { scannerClient } from '@/lib/scanner-client'
import {
  DEFAULT_ADJUSTMENTS,
  ORIGINAL_EFFECTS,
  SMART_EFFECTS,
  type DetectionResult,
  type EnhancementEffect,
  type EnhancementEffects,
  type EnhancementSettings,
  type NormalizedQuad,
  type PageRole,
  type PassportLayout,
  type ScanMode,
  type ScanPage as ScanPageModel,
  type ScanProject,
} from '@/lib/types'
import { createId, modeDefaultName } from '@/lib/utils'

function isScanMode(value?: string): value is ScanMode {
  return value === 'id-card' || value === 'passport' || value === 'document'
}

function nextPageRole(mode: ScanMode, pages: ScanPageModel[]): PageRole {
  if (mode !== 'id-card') return 'page'
  return pages.some((page) => page.role === 'front') ? 'back' : 'front'
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
  const workspaceRef = useRef<HTMLElement | null>(null)
  const [project, setProject] = useState<ScanProject>()
  const [pages, setPages] = useState<ScanPageModel[]>([])
  const [activePageId, setActivePageId] = useState<string>()
  const [stage, setStage] = useState<ScanStage>('capture')
  const [passportLayout, setPassportLayoutState] = useState<PassportLayout>('data-page')
  const [busy, setBusy] = useState(false)
  const [processingProgress, setProcessingProgress] = useState(0)
  const [processingLabel, setProcessingLabel] = useState('正在准备照片')
  const [pendingDelete, setPendingDelete] = useState<ScanPageModel>()
  const [deletingPage, setDeletingPage] = useState(false)
  const [sourceUrl, setSourceUrl] = useState<string>()
  const active = pages.find((page) => page.id === activePageId)
  const activeRef = useScanPersistence(active, project)
  const activeSource = active?.source
  const {
    preview: activePreview,
    isCurrent: previewIsCurrent,
    rendering,
    clearPreview,
  } = useScanPreview(active, stage === 'enhance')
  const updateActive = useCallback(
    (update: (page: ScanPageModel) => ScanPageModel) => {
      if (!activePageId) return
      setPages((current) => current.map((page) => (page.id === activePageId ? update(page) : page)))
    },
    [activePageId],
  )
  const updateCropCorners = useCallback(
    (corners: NormalizedQuad) => {
      updateActive((page) => ({
        ...page,
        corners,
        cornerSource: 'manual',
        cropConfirmed: false,
        updatedAt: Date.now(),
      }))
    },
    [updateActive],
  )

  const mode: ScanMode = project?.mode ?? (isScanMode(routeMode) ? routeMode : 'document')
  const sortedPages = useMemo(() => [...pages].sort((a, b) => a.order - b.order), [pages])
  const nextRole = nextPageRole(mode, pages)
  const pendingDeleteLabel = pendingDelete
    ? mode === 'id-card'
      ? pendingDelete.role === 'front'
        ? '人像面'
        : '国徽面'
      : `第 ${pendingDelete.order + 1} 页`
    : '这个页面'

  useEffect(() => {
    void scannerClient.prewarm().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (stage === 'capture' || !activePageId || window.matchMedia('(min-width: 1024px)').matches)
      return
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
            setActivePageId(storedPages[0].id)
            setStage(storedPages[0].cropConfirmed ? 'enhance' : 'crop')
          } else {
            setActivePageId(undefined)
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
    setActivePageId(undefined)
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
    const filesToProcess =
      mode === 'id-card' ? files.slice(0, Math.max(0, 2 - pages.length)) : files
    if (!filesToProcess.length) return
    setProcessingProgress(0)
    setProcessingLabel(
      filesToProcess.length > 1 ? `正在准备第 1/${filesToProcess.length} 张照片` : '正在准备照片',
    )
    setBusy(true)
    try {
      const currentProject = await ensureProject()
      const workingPages = [...pages]
      const added: ScanPageModel[] = []
      for (const [fileIndex, file] of filesToProcess.entries()) {
        let detection: DetectionResult
        try {
          detection = await scannerClient.detect(file, mode, passportLayout, {
            onProgress: (progress, label) => {
              const batchProgress =
                ((fileIndex + Math.max(0, Math.min(100, progress)) / 100) / filesToProcess.length) *
                100
              setProcessingProgress((current) => Math.max(current, batchProgress))
              setProcessingLabel(
                filesToProcess.length > 1
                  ? `${label} · 第 ${fileIndex + 1}/${filesToProcess.length} 张`
                  : label,
              )
            },
          })
        } catch (reason) {
          setProcessingLabel(
            filesToProcess.length > 1
              ? `正在读取第 ${fileIndex + 1}/${filesToProcess.length} 张照片`
              : '正在读取照片',
          )
          detection = await fallbackDetection(file)
          toast.warning('没有可靠识别到文档边缘', {
            description:
              reason instanceof Error ? `${reason.message}，请手动调整四角。` : '请手动调整四角。',
          })
        }
        const role = nextPageRole(mode, workingPages)
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
        setProcessingProgress(((fileIndex + 1) / filesToProcess.length) * 100)
      }
      await db.projects.update(currentProject.id, {
        updatedAt: Date.now(),
        passportLayout,
      })
      setPages(workingPages)
      if (added[0]) {
        setActivePageId(added[0].id)
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
    const nextPages = pages.map((page) => (page.id === saved.id ? saved : page))
    setPages(nextPages)
    toast.success('页面已保存到本地')
    if (
      mode === 'id-card' &&
      !nextPages.some((page) => page.role === (saved.role === 'front' ? 'back' : 'front'))
    ) {
      setActivePageId(undefined)
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

  const deletePage = async () => {
    if (!pendingDelete) return
    const page = pendingDelete
    setDeletingPage(true)
    try {
      await db.pages.delete(page.id)
      scannerClient.invalidatePage(page.id)
      const remaining = sortedPages
        .filter((item) => item.id !== page.id)
        .map((item, index) => ({ ...item, order: index }))
      await bulkUpdatePageMetadata(remaining)
      setPages(remaining)
      if (activePageId === page.id) {
        setActivePageId(remaining[0]?.id)
        setStage(remaining.length ? (remaining[0].cropConfirmed ? 'enhance' : 'crop') : 'capture')
      }
      setPendingDelete(undefined)
      toast.success('页面已删除')
    } catch (reason) {
      toast.error('页面删除失败', {
        description: reason instanceof Error ? reason.message : '请稍后重试',
      })
    } finally {
      setDeletingPage(false)
    }
  }

  const movePage = async (page: ScanPageModel, direction: -1 | 1) => {
    const ordered = [...sortedPages]
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
  }

  const redetect = async () => {
    if (!active) return
    const pageId = active.id
    setBusy(true)
    try {
      const detection = await scannerClient.detect(active.source, mode, passportLayout)
      if (activeRef.current?.id !== pageId) return
      updateActive((page) => ({
        ...page,
        ...detection,
        cropConfirmed: false,
        updatedAt: Date.now(),
      }))
      toast.success('已重新识别边缘')
    } catch (reason) {
      toast.error('重新识别失败', {
        description: reason instanceof Error ? reason.message : '请手动调整四角',
      })
    } finally {
      setBusy(false)
    }
  }

  const persistActivePage = () => {
    if (!active) return
    const saved = { ...active, updatedAt: Date.now() }
    updateActive(() => saved)
    void updatePageMetadata(saved)
      .then(() =>
        project ? db.projects.update(project.id, { updatedAt: saved.updatedAt }) : undefined,
      )
      .catch((reason: unknown) => {
        toast.error('页面保存失败', {
          id: 'scan-flush-error',
          description: reason instanceof Error ? reason.message : '浏览器无法写入本地存储',
        })
      })
  }

  const selectPage = (page: ScanPageModel) => {
    persistActivePage()
    setActivePageId(page.id)
    setStage(page.cropConfirmed ? 'enhance' : 'crop')
  }

  const startCapture = () => {
    persistActivePage()
    setActivePageId(undefined)
    setStage('capture')
  }

  const changeEffect = (category: keyof EnhancementEffects, effect: EnhancementEffect) => {
    updateActive((page) => ({
      ...page,
      effects: {
        ...page.effects,
        [category]: effect,
      } as EnhancementEffects,
      updatedAt: Date.now(),
    }))
  }

  const applyEffectPreset = (preset: 'original' | 'smart') => {
    updateActive((page) => ({
      ...page,
      effects: {
        ...(preset === 'original' ? ORIGINAL_EFFECTS : SMART_EFFECTS),
      },
      adjustments: { ...DEFAULT_ADJUSTMENTS },
      updatedAt: Date.now(),
    }))
  }

  const changeAdjustments = (adjustments: EnhancementSettings) => {
    updateActive((page) => ({
      ...page,
      adjustments,
      updatedAt: Date.now(),
    }))
  }

  const rotateActive = (direction: 'counterclockwise' | 'clockwise') => {
    updateActive((page) => ({
      ...page,
      rotation: ((page.rotation + (direction === 'clockwise' ? 90 : 270)) %
        360) as ScanPageModel['rotation'],
      updatedAt: Date.now(),
    }))
  }

  const confirmCrop = () => {
    if (!active) return
    const confirmed = { ...active, cropConfirmed: true, updatedAt: Date.now() }
    updateActive(() => confirmed)
    void updatePageMetadata(confirmed).catch((reason: unknown) => {
      updateActive((page) => ({ ...page, cropConfirmed: false }))
      if (activeRef.current?.id === confirmed.id) {
        clearPreview()
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
    clearPreview()
    updateActive(() => unconfirmed)
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
      <ScanPageHeader
        mode={mode}
        project={project}
        pages={sortedPages}
        onBack={() => navigate('/')}
        onRename={renameProject}
      />
      <ScanStageNavigation stage={stage} />

      <div className="bg-card lg:min-h-0 lg:flex-1">
        <div className="mx-auto max-w-[1480px] lg:grid lg:h-full lg:grid-cols-[144px_minmax(0,1fr)_340px]">
          <ScanPageNavigation
            mode={mode}
            pages={sortedPages}
            activeId={activePageId}
            onSelect={selectPage}
            onAdd={startCapture}
            onDelete={setPendingDelete}
            onMove={(page, direction) => void movePage(page, direction)}
          />

          {stage === 'capture' ? (
            <ScanCaptureWorkspace
              mode={mode}
              passportLayout={passportLayout}
              nextRole={nextRole}
              busy={busy}
              progress={processingProgress}
              progressLabel={processingLabel}
              onPassportLayoutChange={(layout) => void setPassportLayout(layout)}
              onFiles={(files) => void processFiles(files)}
            />
          ) : (
            <ScanEditorWorkspace
              stage={stage}
              workspaceRef={workspaceRef}
              page={active}
              sourceUrl={sourceUrl}
              previewUrl={activePreview?.url}
              previewIsCurrent={previewIsCurrent}
              rendering={rendering}
              busy={busy}
              onCropChange={updateCropCorners}
              onRedetect={() => void redetect()}
              onConfirmCrop={confirmCrop}
              onEffectChange={changeEffect}
              onPresetApply={applyEffectPreset}
              onAdjustmentsChange={changeAdjustments}
              onRotate={rotateActive}
              onReopenCrop={reopenCrop}
              onSave={() => void saveActive()}
            />
          )}
        </div>
      </div>

      <ScanDeleteDialog
        open={Boolean(pendingDelete)}
        pageLabel={pendingDeleteLabel}
        deleting={deletingPage}
        onClose={() => setPendingDelete(undefined)}
        onConfirm={() => void deletePage()}
      />
    </div>
  )
}
