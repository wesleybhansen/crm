import * as React from 'react'

import { cn } from '@open-mercato/shared/lib/utils'

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[80px] w-full rounded-[10px] border border-input bg-card px-3 py-2 text-[13.5px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
)

Textarea.displayName = 'Textarea'
