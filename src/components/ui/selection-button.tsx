import { Check } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'
import { Button } from './button'
import { cn } from '@/lib/utils'

export function SelectionButton({
  selected,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={selected}
      className={cn(
        'h-auto min-h-10 min-w-0 rounded-lg px-2 py-2 text-xs whitespace-normal',
        selected
          ? 'border-primary/20 bg-secondary text-primary hover:bg-secondary hover:text-primary'
          : 'bg-muted text-foreground',
        className,
      )}
      {...props}
    >
      <span className="inline-flex min-w-0 items-center justify-center gap-1.5">
        {selected && <Check className="size-3.5 shrink-0" />}
        <span>{children}</span>
      </span>
    </Button>
  )
}
