import { useEffect, useState } from 'react'
import { CheckCircle2, Cpu, LoaderCircle, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { clearScannerData, db } from '@/lib/db'
import { useAppStore } from '@/store/app-store'

export function SettingsPage() {
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false)
  const [clearingHistory, setClearingHistory] = useState(false)
  const [historyCounts, setHistoryCounts] = useState({ projects: 0, pages: 0 })
  const engineReady = useAppStore((state) => state.engineReady)
  const engineLabel = useAppStore((state) => state.engineLabel)

  const refreshHistoryCounts = async () => {
    const [projects, pages] = await Promise.all([db.projects.count(), db.pages.count()])
    setHistoryCounts({ projects, pages })
  }

  useEffect(() => {
    void refreshHistoryCounts()
  }, [])

  const clearHistory = async () => {
    setClearingHistory(true)
    try {
      await clearScannerData()
      await refreshHistoryCounts()
      setClearHistoryOpen(false)
      toast.success('所有扫描历史已清空')
    } catch (reason) {
      toast.error('扫描历史清理失败', {
        description: reason instanceof Error ? reason.message : '请关闭其他页面后重试',
      })
    } finally {
      setClearingHistory(false)
    }
  }

  return (
    <div className="min-h-[calc(100svh-4rem)] pb-24 pt-9 sm:pt-12">
      <div>
        <p className="text-xs font-bold uppercase tracking-[.18em] text-primary">Local processing</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">本地图像引擎</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          文档识别、透视校正和全部增强效果都在当前设备中完成，扫描图片不会上传。
        </p>
      </div>

      <Card className="mt-8 max-w-3xl">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <span className="grid size-11 place-items-center rounded-2xl bg-secondary text-primary">
              <Cpu />
            </span>
            <Badge variant="secondary">随应用提供</Badge>
          </div>
          <CardTitle className="pt-3">标准文档增强</CardTitle>
          <CardDescription>OpenCV 多尺度平场、去阴影、去反光、黑白与细节增强。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 rounded-2xl bg-muted p-4 text-sm">
            {engineReady ? <CheckCircle2 className="size-4 text-primary" /> : <Cpu className="size-4 text-primary" />}
            <span className="font-semibold">
              {engineReady
                ? '可用'
                : engineLabel === '正在准备本地图像引擎'
                  ? '随用随启，首次扫描时自动加载'
                  : engineLabel}
            </span>
          </div>
          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
            无需额外模型、无需联网，也不依赖 Web Crypto。普通 HTTP 环境可直接测试。
          </p>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-red-50 text-destructive">
                <ShieldAlert />
              </span>
              <div>
                <CardTitle>扫描历史数据</CardTitle>
                <CardDescription className="mt-1.5">
                  当前保存 {historyCounts.projects} 个项目、
                  {historyCounts.pages} 个页面。
                </CardDescription>
              </div>
            </div>
            <Button
              variant="destructive"
              disabled={clearingHistory || historyCounts.projects + historyCounts.pages === 0}
              onClick={() => setClearHistoryOpen(true)}
            >
              {clearingHistory ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              清空所有历史数据
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Dialog open={clearHistoryOpen} onOpenChange={setClearHistoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="text-destructive" />
              清空所有扫描历史？
            </DialogTitle>
            <DialogDescription>
              所有项目、原图、缩略图、编辑设置和页面缓存都会永久删除，已经导出的文件不受影响。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={clearingHistory} onClick={() => setClearHistoryOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={clearingHistory} onClick={() => void clearHistory()}>
              {clearingHistory ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              确认清空
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
