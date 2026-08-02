import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-3xl border border-border/80 bg-card text-card-foreground shadow-[0_1px_2px_rgba(19,38,30,.03),0_12px_40px_rgba(19,38,30,.04)]',
        className,
      )}
      {...props}
    />
  )
}
