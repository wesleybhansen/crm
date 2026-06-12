import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@open-mercato/shared/lib/utils'

const chipViolet =
  'border-[rgba(124,58,237,.24)] bg-[rgba(124,58,237,.09)] text-[#6d28d9] dark:border-[rgba(139,92,246,.32)] dark:bg-[rgba(139,92,246,.16)] dark:text-[#c4b5fd]'
const chipBlue =
  'border-[rgba(37,99,235,.22)] bg-[rgba(37,99,235,.08)] text-[#1d4ed8] dark:border-[rgba(59,130,246,.30)] dark:bg-[rgba(59,130,246,.15)] dark:text-[#93c5fd]'
const chipGreen =
  'border-[rgba(16,185,129,.26)] bg-[rgba(16,185,129,.10)] text-[#047857] dark:border-[rgba(16,185,129,.30)] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399]'
const chipAmber =
  'border-[rgba(217,119,6,.26)] bg-[rgba(217,119,6,.10)] text-[#b45309] dark:border-[rgba(245,158,11,.30)] dark:bg-[rgba(245,158,11,.13)] dark:text-[#fbbf24]'
const chipRed =
  'border-[rgba(239,68,68,.24)] bg-[rgba(239,68,68,.10)] text-[#b91c1c] dark:border-[rgba(239,68,68,.30)] dark:bg-[rgba(239,68,68,.13)] dark:text-[#f87171]'
const chipNeutral = 'border-input bg-foreground/10 text-muted-foreground'

const badgeVariants = cva(
  'inline-flex h-[21px] items-center rounded-full border px-2 font-mono text-[10px] font-semibold uppercase tracking-[.07em] whitespace-nowrap transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: chipViolet,
        secondary: chipNeutral,
        destructive: chipRed,
        outline: 'border-input bg-transparent text-muted-foreground',
        muted: chipNeutral,
        violet: chipViolet,
        blue: chipBlue,
        green: chipGreen,
        amber: chipAmber,
        red: chipRed,
        neutral: chipNeutral,
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export type BadgeProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>

export const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
))

Badge.displayName = 'Badge'

export { badgeVariants }
