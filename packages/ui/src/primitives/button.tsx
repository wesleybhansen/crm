import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@open-mercato/shared/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-[13.5px] font-semibold cursor-pointer transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:brightness-110 hover:-translate-y-px',
        destructive:
          'bg-transparent text-[#b91c1c] hover:bg-[rgba(239,68,68,.10)] dark:text-[#f87171] dark:hover:bg-[rgba(239,68,68,.13)] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        outline:
          'border border-input bg-card text-foreground/90 hover:border-foreground/20 hover:bg-foreground/[.03] dark:hover:bg-white/[.035]',
        secondary: 'border border-input bg-card text-foreground/90 hover:border-foreground/20 hover:bg-foreground/[.03] dark:hover:bg-white/[.035]',
        ghost: 'text-muted-foreground hover:text-foreground hover:bg-foreground/[.03] dark:hover:bg-white/[.035]',
        muted: 'text-muted-foreground hover:text-foreground hover:bg-foreground/[.03] dark:hover:bg-white/[.035]',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-[34px] px-4 py-2 has-[>svg]:px-3',
        sm: 'h-[28px] gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 px-6 has-[>svg]:px-4',
        icon: 'size-[33px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { buttonVariants }

