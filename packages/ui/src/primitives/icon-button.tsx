import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@open-mercato/shared/lib/utils'

const iconButtonVariants = cva(
  "inline-flex items-center justify-center rounded-[10px] cursor-pointer transition-all outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  {
    variants: {
      variant: {
        outline:
          'border border-input bg-card text-foreground/90 hover:border-foreground/20 hover:bg-foreground/[.03] dark:hover:bg-white/[.035]',
        ghost: 'text-muted-foreground hover:text-foreground hover:bg-foreground/[.03] dark:hover:bg-white/[.035]',
      },
      size: {
        xs: 'size-6',
        sm: 'size-7',
        default: 'size-[33px]',
        lg: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'default',
    },
  }
)

export function IconButton({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof iconButtonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp data-slot="icon-button" type={asChild ? undefined : 'button'} className={cn(iconButtonVariants({ variant, size, className }))} {...props} />
}

export { iconButtonVariants }
