import { useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface ImageCaptureInstance {
  takePhoto: () => Promise<Blob>
}

interface ImageCaptureConstructor {
  new (track: MediaStreamTrack): ImageCaptureInstance
}

export function CameraDialog({
  open,
  onOpenChange,
  onCapture,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCapture: (file: File) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setCapturing(false)
    setError(undefined)
    if (!navigator.mediaDevices?.getUserMedia) {
      setLoading(false)
      setError(
        window.isSecureContext
          ? '当前浏览器没有提供网页摄像头接口'
          : '网页摄像头需要 HTTPS 或 localhost 环境',
      )
      return
    }
    void navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1920 },
        },
      })
      .then(async (stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        setLoading(false)
      })
      .catch((reason: unknown) => {
        setLoading(false)
        setError(reason instanceof Error ? reason.message : '无法访问摄像头')
      })

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = undefined
    }
  }, [open])

  const capture = async () => {
    const stream = streamRef.current
    const video = videoRef.current
    if (!stream || !video || capturing) return
    setCapturing(true)
    try {
      let blob: Blob
      const track = stream.getVideoTracks()[0]
      const Capture = (window as unknown as { ImageCapture?: ImageCaptureConstructor }).ImageCapture
      if (Capture) {
        blob = await new Capture(track).takePhoto()
      } else {
        const settings = track.getSettings()
        const canvas = document.createElement('canvas')
        canvas.width = settings.width ?? video.videoWidth
        canvas.height = settings.height ?? video.videoHeight
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法截取摄像头画面')
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) => (value ? resolve(value) : reject(new Error('拍摄失败'))),
            'image/jpeg',
            0.95,
          ),
        )
      }
      onCapture(new File([blob], `camera-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' }))
      onOpenChange(false)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '拍摄失败')
    } finally {
      setCapturing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl bg-[#0c1813] p-3 text-white">
        <DialogHeader className="px-3 pt-2">
          <DialogTitle className="text-white">摄像头拍摄</DialogTitle>
        </DialogHeader>
        <div className="paper-grid relative aspect-[4/3] overflow-hidden rounded-2xl bg-black">
          <video ref={videoRef} playsInline muted className="size-full object-cover" />
          {loading && (
            <div className="absolute inset-0 grid place-items-center bg-black/55">
              <LoaderCircle className="size-8 animate-spin" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center">
              <CameraOff className="size-8 text-red-300" />
              <p className="text-sm">{error}</p>
              <p className="text-xs text-white/60">请允许摄像头权限，或改用上传照片。</p>
            </div>
          )}
          {!error && !loading && (
            <div className="pointer-events-none absolute inset-[9%] rounded-lg border border-emerald-300/70">
              <span className="absolute -left-px -top-px size-7 border-l-2 border-t-2 border-emerald-300" />
              <span className="absolute -right-px -top-px size-7 border-r-2 border-t-2 border-emerald-300" />
              <span className="absolute -bottom-px -left-px size-7 border-b-2 border-l-2 border-emerald-300" />
              <span className="absolute -bottom-px -right-px size-7 border-b-2 border-r-2 border-emerald-300" />
            </div>
          )}
        </div>
        <div className="flex justify-center pb-2">
          <Button
            size="lg"
            disabled={loading || capturing || Boolean(error)}
            onClick={() => void capture()}
            className="size-14 rounded-full p-0 ring-4 ring-white/20"
          >
            {capturing ? (
              <LoaderCircle className="size-6 animate-spin" />
            ) : (
              <Camera className="size-6" />
            )}
            <span className="sr-only">{capturing ? '正在拍照' : '拍照'}</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
