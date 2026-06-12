import * as React from 'react'

export type NotificationCountBadgeProps = {
  count: number
}

export function NotificationCountBadge({ count }: NotificationCountBadgeProps) {
  if (count <= 0) return null
  return (
    <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[9px] font-medium tabular-nums text-primary-foreground ring-2 ring-background">
      {count > 99 ? '99+' : count}
    </span>
  )
}
