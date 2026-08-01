import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  CheckCircle2,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wifi,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import {
  ADVANCED_MODEL,
  installAdvancedModel,
  prepareInstalledAdvancedModel,
  refreshAdvancedModelStatus,
  uninstallAdvancedModel,
} from '@/lib/advanced-model'
import { useAppStore } from '@/store/app-store'

function formatBytes(value: number) {
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

export function SettingsPage() {
  const controller = useRef<AbortController | undefined>(undefined)
  const [storage, setStorage] = useState<{ usage?: number; quota?: number }>()
  const [working, setWorking] = useState(false)
  const engineReady = useAppStore((state) => state.engineReady)
  const engineLabel = useAppStore((state) => state.engineLabel)
  const modelState = useAppStore((state) => state.modelState)
  const modelProgress = useAppStore((state) => state.modelProgress)
  const modelLabel = useAppStore((state) => state.modelLabel)
  const record = useAppStore((state) => state.modelRecord)
  const installing = modelState === 'installing'

  const storageLabel = useMemo(() => {
    if (!storage?.quota) return '浏览器未提供容量信息'
    const free = Math.max(0, storage.quota - (storage.usage ?? 0))
    return `可用约 ${formatBytes(free)} / 总计 ${formatBytes(storage.quota)}`
  }, [storage])

  const refreshStorage = async () => {
    if (!navigator.storage?.estimate) return
    setStorage(await navigator.storage.estimate())
  }

  useEffect(() => {
    void Promise.all([refreshAdvancedModelStatus(), refreshStorage()])
    return () => controller.current?.abort()
  }, [])

  const install = async () => {
    const next = new AbortController()
    controller.current = next
    setWorking(true)
    try {
      await installAdvancedModel(next.signal)
      await refreshStorage()
      toast.success('高级去阴影已安装并通过自检')
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        toast.error('安装失败', { description: reason instanceof Error ? reason.message : '请重试' })
      }
    } finally {
      controller.current = undefined
      setWorking(false)
    }
  }

  const retest = async () => {
    setWorking(true)
    try {
      await prepareInstalledAdvancedModel(true)
      toast.success('模型测速完成')
    } catch (reason) {
      toast.error('模型自检失败', { description: reason instanceof Error ? reason.message : '请重新安装' })
    } finally {
      setWorking(false)
    }
  }

  const uninstall = async () => {
    if (!window.confirm('卸载高级模型？已保存在扫描页面中的校正结果会继续保留。')) return
    setWorking(true)
    try {
      await uninstallAdvancedModel()
      await refreshStorage()
      toast.success('高级模型已卸载', { description: '历史页面的校正图未被删除。' })
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="min-h-[calc(100svh-4rem)] pb-24 pt-9 sm:pt-12">
      <div>
        <p className="text-xs font-bold uppercase tracking-[.18em] text-primary">Local processing</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">本地图像引擎</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          标准扫描能力随应用提供；高级去阴影仅在你主动安装后下载，并始终在当前设备中推理。
        </p>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <span className="grid size-11 place-items-center rounded-2xl bg-secondary text-primary"><Cpu /></span>
              <Badge variant="secondary">随应用安装</Badge>
            </div>
            <CardTitle className="pt-3">标准文档增强</CardTitle>
            <CardDescription>OpenCV 多尺度平场、去阴影、去反光、黑白与细节增强。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 rounded-2xl bg-muted p-4 text-sm">
              {engineReady ? <CheckCircle2 className="size-4 text-primary" /> : <Cpu className="size-4 text-primary" />}
              <span className="font-semibold">{engineReady ? '可用' : engineLabel === '正在准备本地图像引擎' ? '随用随启，首次扫描时自动加载' : engineLabel}</span>
            </div>
            <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />无需模型、无需联网，也不依赖 Web Crypto。普通 HTTP 环境可直接测试。</p>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="grid size-11 place-items-center rounded-2xl bg-primary text-white"><Bot /></span>
              <Badge variant={modelState === 'ready' ? 'default' : 'secondary'}>
                {modelState === 'ready' ? '已安装' : modelState === 'installing' ? '安装中' : modelState === 'error' ? '需重试' : '可选组件'}
              </Badge>
            </div>
            <CardTitle className="pt-3">AI 高级去阴影</CardTitle>
            <CardDescription>DocShadow SD7K FP16，擅长手掌、折痕和大面积渐变阴影。原始文字细节由高分辨率图像保留。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="flex items-center gap-2 rounded-xl bg-muted p-3"><Database className="size-4 text-primary" /><span><b>{formatBytes(ADVANCED_MODEL.bytes)}</b><br /><span className="text-muted-foreground">一次性本地组件</span></span></div>
              <div className="flex items-center gap-2 rounded-xl bg-muted p-3"><HardDrive className="size-4 text-primary" /><span><b>{storageLabel}</b><br /><span className="text-muted-foreground">安装需预留约 71 MiB</span></span></div>
              {record?.backend && <div className="flex items-center gap-2 rounded-xl bg-muted p-3"><Gauge className="size-4 text-primary" /><span><b>{record.backend === 'webgpu' ? 'WebGPU' : 'WebAssembly'}</b><br /><span className="text-muted-foreground">{record.inputSize} px · {Math.round(record.benchmarkMs ?? 0)} ms 基准</span></span></div>}
              <div className="flex items-center gap-2 rounded-xl bg-muted p-3"><ShieldCheck className="size-4 text-primary" /><span><b>图片不上传</b><br /><span className="text-muted-foreground">权重与校正图存于 IndexedDB</span></span></div>
            </div>

            {(installing || modelState === 'error') && (
              <div className="rounded-2xl border border-border bg-background p-4">
                <div className="mb-2 flex items-center justify-between gap-3 text-xs"><span className="font-semibold">{modelLabel}</span><span className="tabular-nums">{modelProgress}%</span></div>
                <Progress value={modelProgress} />
              </div>
            )}

            {!window.isSecureContext && (
              <p className="flex items-start gap-2 rounded-2xl bg-amber-50 p-3 text-xs leading-5 text-amber-900"><Wifi className="mt-0.5 size-4 shrink-0" />当前是普通 HTTP：模型仍可用 WebAssembly 运行，但 WebGPU、多线程 WASM、PWA 安装与离线 Service Worker 会受限。</p>
            )}

            <div className="flex flex-wrap gap-2">
              {installing ? (
                <Button variant="outline" onClick={() => controller.current?.abort()}><X />取消安装</Button>
              ) : modelState === 'ready' ? (
                <>
                  <Button variant="outline" disabled={working} onClick={() => void retest()}>{working ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}重新测速</Button>
                  <Button variant="destructive" disabled={working} onClick={() => void uninstall()}><Trash2 />卸载模型</Button>
                </>
              ) : (
                <Button disabled={working} onClick={() => void install()}>{working ? <LoaderCircle className="animate-spin" /> : <Bot />}{modelState === 'error' ? '重试安装' : '安装高级模型'}</Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
