import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@open-mercato/shared/lib/utils'

const alertVariants = cva(
  "relative w-full rounded-[10px] border px-4 py-3 text-[13px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-8 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-foreground',
        destructive:
          'border-[rgba(239,68,68,.20)] bg-[rgba(239,68,68,.06)] text-[#b91c1c] dark:border-[rgba(239,68,68,.25)] dark:bg-[rgba(239,68,68,.09)] dark:text-[#f87171]',
        success:
          'border-[rgba(16,185,129,.22)] bg-[rgba(16,185,129,.06)] text-[#047857] dark:border-[rgba(16,185,129,.25)] dark:bg-[rgba(16,185,129,.09)] dark:text-[#34d399]',
        warning:
          'border-[rgba(217,119,6,.22)] bg-[rgba(217,119,6,.06)] text-[#b45309] dark:border-[rgba(245,158,11,.25)] dark:bg-[rgba(245,158,11,.08)] dark:text-[#fbbf24]',
        info:
          'border-[rgba(37,99,235,.18)] bg-[rgba(37,99,235,.05)] text-[#1d4ed8] dark:border-[rgba(59,130,246,.25)] dark:bg-[rgba(59,130,246,.10)] dark:text-[#93c5fd]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

type AlertProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
))

Alert.displayName = 'Alert'

const AlertTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn('mb-1 text-[13.5px] font-semibold leading-tight', className)} {...props} />
  )
)

AlertTitle.displayName = 'AlertTitle'

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-[13px] leading-relaxed', className)} {...props} />
  )
)

AlertDescription.displayName = 'AlertDescription'

export { Alert, AlertDescription, AlertTitle, alertVariants }
