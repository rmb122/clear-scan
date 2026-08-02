import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Badge } from '@/components/ui/badge'
import type { CornerSource, NormalizedQuad } from '@/lib/types'
import { clamp } from '@/lib/geometry'

interface ActiveDrag {
  index: number
  pointerId: number
  changed: boolean
}

function cloneCorners(corners: NormalizedQuad) {
  return corners.map((point) => ({ ...point })) as NormalizedQuad
}

export function CropEditor({
  sourceUrl,
  width,
  height,
  corners,
  cornerSource,
  onChange,
}: {
  sourceUrl: string
  width: number
  height: number
  corners: NormalizedQuad
  cornerSource: CornerSource
  onChange: (corners: NormalizedQuad) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [draftCorners, setDraftCorners] = useState(() => cloneCorners(corners))
  const draftCornersRef = useRef(draftCorners)
  const receivedCornersRef = useRef(corners)
  const dragRef = useRef<ActiveDrag | undefined>(undefined)
  const pendingPointRef = useRef<NormalizedQuad[number] | undefined>(undefined)
  const frameRef = useRef<number | undefined>(undefined)

  useLayoutEffect(() => {
    if (dragRef.current || receivedCornersRef.current === corners) return
    receivedCornersRef.current = corners
    const next = cloneCorners(corners)
    draftCornersRef.current = next
    setDraftCorners(next)
  }, [corners])

  const flushPendingPoint = useCallback(() => {
    frameRef.current = undefined
    const drag = dragRef.current
    const point = pendingPointRef.current
    if (!drag || !point) return draftCornersRef.current
    pendingPointRef.current = undefined
    const next = [...draftCornersRef.current] as NormalizedQuad
    next[drag.index] = point
    draftCornersRef.current = next
    setDraftCorners(next)
    return next
  }, [])

  const startDrag = useCallback((index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current) return
    event.preventDefault()
    pendingPointRef.current = undefined
    dragRef.current = {
      index,
      pointerId: event.pointerId,
      changed: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      const point = {
        x: clamp((event.clientX - rect.left) / rect.width, 0.005, 0.995),
        y: clamp((event.clientY - rect.top) / rect.height, 0.005, 0.995),
      }
      const current = pendingPointRef.current ?? draftCornersRef.current[drag.index]
      if (current.x === point.x && current.y === point.y) return
      pendingPointRef.current = point
      drag.changed = true
      if (frameRef.current === undefined) {
        frameRef.current = window.requestAnimationFrame(flushPendingPoint)
      }
    },
    [flushPendingPoint],
  )

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      if (frameRef.current !== undefined) {
        window.cancelAnimationFrame(frameRef.current)
      }
      const next = flushPendingPoint()
      dragRef.current = undefined
      pendingPointRef.current = undefined
      if (drag.changed) {
        receivedCornersRef.current = next
        onChange(next)
      }
    },
    [flushPendingPoint, onChange],
  )

  useEffect(() => {
    return () => {
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const polygon = draftCorners.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')

  return (
    <div className="flex size-full items-center justify-center px-3 pb-3 pt-12 sm:px-7 sm:pb-7 sm:pt-14">
      <div
        ref={containerRef}
        className="relative max-h-full max-w-full select-none overflow-visible shadow-[0_18px_60px_rgba(0,0,0,.4)]"
        style={{
          aspectRatio: `${width} / ${height}`,
          width: width >= height ? 'min(100%, 920px)' : 'auto',
          height: width < height ? 'min(100%, 760px)' : 'auto',
        }}
      >
        <img src={sourceUrl} alt="待裁剪文档" className="pointer-events-none size-full object-fill" draggable={false} />
        <svg
          className="pointer-events-none absolute inset-0 size-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <mask id="crop-mask">
              <rect width="100" height="100" fill="white" />
              <polygon points={polygon} fill="black" />
            </mask>
          </defs>
          <rect width="100" height="100" fill="rgba(0,0,0,.52)" mask="url(#crop-mask)" />
          <polygon
            points={polygon}
            fill="rgba(34,197,94,.035)"
            stroke="#3ee49f"
            strokeWidth="0.55"
            vectorEffect="non-scaling-stroke"
          />
          {draftCorners.map((point, index) => {
            const next = draftCorners[(index + 1) % draftCorners.length]
            return (
              <line
                key={`line-${index}`}
                x1={point.x * 100}
                y1={point.y * 100}
                x2={next.x * 100}
                y2={next.y * 100}
                stroke="rgba(255,255,255,.7)"
                strokeWidth="0.18"
                strokeDasharray="1 1"
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </svg>
        {draftCorners.map((point, index) => (
          <button
            key={index}
            type="button"
            aria-label={`拖动第 ${index + 1} 个裁剪点`}
            className="absolute z-10 grid size-11 -translate-x-1/2 -translate-y-1/2 touch-none place-items-center rounded-full bg-transparent outline-none transition hover:scale-105 focus-visible:ring-4 focus-visible:ring-white/75"
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            onPointerDown={(event) => {
              startDrag(index, event)
            }}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onLostPointerCapture={finishDrag}
          >
            <span className="pointer-events-none size-8 rounded-full border-[3px] border-white bg-primary shadow-[0_2px_12px_rgba(0,0,0,.45)] ring-2 ring-primary/40" />
          </button>
        ))}
        <Badge
          variant={cornerSource === 'detected' || cornerSource === 'manual' ? 'default' : 'warning'}
          className="pointer-events-none absolute -top-10 left-0 shadow-sm"
        >
          {cornerSource === 'detected'
            ? '已预识别边缘，请人工确认'
            : cornerSource === 'manual'
              ? '已手动调整边缘'
              : cornerSource === 'fallback'
                ? '未可靠识别，请拖动四角'
                : '请人工确认文档边缘'}
        </Badge>
      </div>
    </div>
  )
}
