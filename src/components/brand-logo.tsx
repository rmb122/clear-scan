import { cn } from '@/lib/utils'

export function BrandLogo({
  compact = false,
  className,
}: {
  compact?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span className="relative grid size-9 place-items-center overflow-hidden rounded-xl bg-primary shadow-[0_6px_18px_rgba(8,127,91,.22)]">
        <svg viewBox="0 0 36 36" className="size-8 text-white" aria-hidden="true">
          <path
            d="M10 6H6v7M26 6h4v7M10 30H6v-7M26 30h4v-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path
            d="M11 11.5h14v13H11z"
            fill="rgba(255,255,255,.18)"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M14 16h8M14 19h8M14 22h5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      {!compact && (
        <span className="leading-none">
          <span className="block text-[15px] font-bold tracking-tight">清晰扫描</span>
          <span className="mt-1 block text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Clear Scan
          </span>
        </span>
      )}
    </div>
  )
}
