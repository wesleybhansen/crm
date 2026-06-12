import * as React from 'react'
import { cn } from '@open-mercato/shared/lib/utils'

type InputProps = React.ComponentPropsWithoutRef<'input'>

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-[34px] w-full rounded-[10px] border border-input bg-card px-3 py-2 text-[13.5px] transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
)

Input.displayName = 'Input'
