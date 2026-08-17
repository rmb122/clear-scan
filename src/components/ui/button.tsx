import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all outline-none disabled:pointer-events-none disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/75',
        outline: 'border border-border bg-background hover:border-primary/30 hover:bg-muted',
        ghost: 'hover:bg-muted hover:text-foreground',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-12 rounded-2xl px-6 text-[15px]',
        icon: 'size-10 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button'
  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button }
