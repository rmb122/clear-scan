import { useEffect, useState } from 'react'
import { Download, MoreHorizontal, RefreshCw, Share, WifiOff } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function PwaLifecycle() {
  const {
    offlineReady: [offlineReady],
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  useEffect(() => {
    if (offlineReady) toast.success('离线扫描已就绪')
  }, [offlineReady])

  useEffect(() => {
    if (!needRefresh) return
    toast('发现新版本', {
      description: '更新会在你确认后加载。',
      action: {
        label: '立即更新',
        onClick: () => void updateServiceWorker(true),
      },
      duration: 10_000,
    })
  }, [needRefresh, updateServiceWorker])

  return null
}

export function OnlineBadge() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  if (online) return null
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
      <WifiOff className="size-3" /> 离线模式
    </span>
  )
}

export function InstallButton() {
  const [prompt, setPrompt] = useState<InstallPromptEvent>()
  const [showIos, setShowIos] = useState(false)
  const standalone = window.matchMedia('(display-mode: standalone)').matches
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault()
      setPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  if (standalone) return null

  const install = async () => {
    if (prompt) {
      await prompt.prompt()
      await prompt.userChoice
      setPrompt(undefined)
    } else if (isIos) {
      setShowIos(true)
    } else {
      toast('可通过浏览器菜单安装', {
        description: '选择“安装应用”或“创建快捷方式”。',
      })
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void install()}
        className="sm:hidden"
        aria-label="安装应用"
      >
        <Download />
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void install()}
        className="hidden text-sm sm:inline-flex"
      >
        <Download /> 安装应用
      </Button>
      <Dialog open={showIos} onOpenChange={setShowIos}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加到主屏幕</DialogTitle>
            <DialogDescription>
              安装后可像普通 App 一样打开，并在完成首次缓存后离线扫描。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-2xl bg-muted p-4 text-sm leading-6">
            <p className="flex gap-3">
              <Share className="mt-1 size-4 shrink-0 text-primary" />
              点击 Safari 底部的“分享”按钮。
            </p>
            <p className="flex gap-3">
              <MoreHorizontal className="mt-1 size-4 shrink-0 text-primary" />
              向下查找并选择“添加到主屏幕”。
            </p>
            <p className="flex gap-3">
              <RefreshCw className="mt-1 size-4 shrink-0 text-primary" />
              首次打开后等待“离线扫描已就绪”提示。
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
