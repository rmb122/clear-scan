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
import { cn } from '@/lib/utils'

interface ActiveDrag {
  index: number
  pointerId: number
  changed: boolean
  handleOffset: { x: number; y: number }
  grabOffset: { x: number; y: number }
  viewport: { width: number; height: number }
}

const HANDLE_OFFSET_DISTANCE = 36
const HANDLE_OFFSET_COMPONENT = HANDLE_OFFSET_DISTANCE / Math.sqrt(2)
const HANDLE_OFFSETS = [
  { x: -HANDLE_OFFSET_COMPONENT, y: -HANDLE_OFFSET_COMPONENT },
  { x: HANDLE_OFFSET_COMPONENT, y: -HANDLE_OFFSET_COMPONENT },
  { x: HANDLE_OFFSET_COMPONENT, y: HANDLE_OFFSET_COMPONENT },
  { x: -HANDLE_OFFSET_COMPONENT, y: HANDLE_OFFSET_COMPONENT },
] as const
const MAGNIFIER_ZOOM = 2.5

function cloneCorners(corners: NormalizedQuad) {
  return corners.map((point) => ({ ...point })) as NormalizedQuad
}

function getMagnifierGeometry(
  point: NormalizedQuad[number],
  index: number,
  viewport: ActiveDrag['viewport'],
) {
  const minSide = Math.min(viewport.width, viewport.height)
  const maxSize = Math.max(32, minSide - 8)
  const size = Math.min(104, Math.max(64, minSide * 0.42), maxSize)
  const pointX = point.x * viewport.width
  const pointY = point.y * viewport.height
  const gap = 14
  const opensRight = index === 0 || index === 3
  const opensDown = index === 0 || index === 1
  const preferredLeft = opensRight ? pointX + gap : pointX - size - gap
  const preferredTop = opensDown ? pointY + gap : pointY - size - gap
  const maxLeft = Math.max(4, viewport.width - size - 4)
  const maxTop = Math.max(4, viewport.height - size - 4)

  return {
    size,
    left: clamp(preferredLeft, 4, maxLeft),
    top: clamp(preferredTop, 4, maxTop),
    imageLeft: size / 2 - pointX * MAGNIFIER_ZOOM,
    imageTop: size / 2 - pointY * MAGNIFIER_ZOOM,
    imageWidth: viewport.width * MAGNIFIER_ZOOM,
    imageHeight: viewport.height * MAGNIFIER_ZOOM,
  }
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
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined)
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
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    const point = draftCornersRef.current[index]
    const handleOffset = HANDLE_OFFSETS[index]
    const handleCenter = {
      x: rect.left + point.x * rect.width + handleOffset.x,
      y: rect.top + point.y * rect.height + handleOffset.y,
    }
    pendingPointRef.current = undefined
    dragRef.current = {
      index,
      pointerId: event.pointerId,
      changed: false,
      handleOffset,
      grabOffset: {
        x: event.clientX - handleCenter.x,
        y: event.clientY - handleCenter.y,
      },
      viewport: { width: rect.width, height: rect.height },
    }
    setActiveIndex(index)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is an enhancement; the drag still works without it.
    }
  }, [])

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      const point = {
        x: clamp(
          (event.clientX - rect.left - drag.handleOffset.x - drag.grabOffset.x) / rect.width,
          0.005,
          0.995,
        ),
        y: clamp(
          (event.clientY - rect.top - drag.handleOffset.y - drag.grabOffset.y) / rect.height,
          0.005,
          0.995,
        ),
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
      setActiveIndex(undefined)
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
  const activeDrag = activeIndex === undefined ? undefined : dragRef.current
  const magnifier = activeDrag
    ? getMagnifierGeometry(draftCorners[activeDrag.index], activeDrag.index, activeDrag.viewport)
    : undefined

  return (
    <div className="flex size-full items-center justify-center px-12 pb-12 pt-16 sm:px-14 sm:pb-14">
      <div
        ref={containerRef}
        className="relative max-h-full max-w-full select-none overflow-visible shadow-[0_18px_60px_rgba(0,0,0,.4)]"
        style={{
          aspectRatio: `${width} / ${height}`,
          width: width >= height ? 'min(100%, 920px)' : 'auto',
          height: width < height ? 'min(100%, 760px)' : 'auto',
        }}
      >
        <img
          src={sourceUrl}
          alt="待裁剪文档"
          className="pointer-events-none size-full object-fill"
          draggable={false}
        />
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
        {draftCorners.map((point, index) => {
          const offset = HANDLE_OFFSETS[index]
          const angle = Math.atan2(offset.y, offset.x)
          return (
            <div key={index}>
              <span
                data-testid={`crop-connector-${index}`}
                className="pointer-events-none absolute z-[8] h-0.5 origin-left rounded-full bg-white/80 shadow-sm"
                style={{
                  left: `${point.x * 100}%`,
                  top: `${point.y * 100}%`,
                  width: `${HANDLE_OFFSET_DISTANCE}px`,
                  transform: `translateY(-50%) rotate(${angle}rad)`,
                }}
              />
              <span
                className="pointer-events-none absolute z-[9] size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow-sm"
                style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
              />
              <button
                type="button"
                aria-label={`拖动第 ${index + 1} 个裁剪点`}
                className={cn(
                  'absolute z-20 grid size-12 -translate-x-1/2 -translate-y-1/2 touch-none place-items-center rounded-full bg-transparent outline-none transition-transform hover:scale-105 focus-visible:ring-4 focus-visible:ring-white/75',
                  activeIndex === index && 'scale-110',
                )}
                style={{
                  left: `${point.x * 100}%`,
                  top: `${point.y * 100}%`,
                  marginLeft: `${offset.x}px`,
                  marginTop: `${offset.y}px`,
                }}
                onPointerDown={(event) => {
                  startDrag(index, event)
                }}
                onPointerMove={moveDrag}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
                onLostPointerCapture={finishDrag}
              >
                <span
                  className={cn(
                    'pointer-events-none size-6 rounded-full border-2 border-white bg-primary shadow-[0_3px_14px_rgba(0,0,0,.5)] ring-2 ring-primary/45 transition-all',
                    activeIndex === index && 'bg-white ring-4 ring-primary/65',
                  )}
                />
              </button>
            </div>
          )
        })}
        {magnifier && activeDrag && (
          <div
            data-testid="crop-magnifier"
            className="pointer-events-none absolute z-30 overflow-hidden rounded-full border-2 border-white bg-[#12241c] shadow-[0_8px_28px_rgba(0,0,0,.6)] ring-2 ring-primary/80"
            style={{
              left: magnifier.left,
              top: magnifier.top,
              width: magnifier.size,
              height: magnifier.size,
            }}
          >
            <img
              src={sourceUrl}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="absolute max-w-none select-none"
              style={{
                left: magnifier.imageLeft,
                top: magnifier.imageTop,
                width: magnifier.imageWidth,
                height: magnifier.imageHeight,
              }}
            />
            <span className="absolute left-1/2 top-1/2 h-px w-6 -translate-x-1/2 -translate-y-1/2 bg-white shadow-[0_0_2px_#000]" />
            <span className="absolute left-1/2 top-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-white shadow-[0_0_2px_#000]" />
            <span className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary bg-white" />
          </div>
        )}
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
