'use client'

import Link from 'next/link'
import { PlugZap } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { IconButton } from '../primitives/icon-button'

export type IntegrationsButtonProps = {
  href?: string
}

export function IntegrationsButton({ href = '/backend/integrations' }: IntegrationsButtonProps) {
  const t = useT()
  const label = t('integrations.nav.title', 'Integrations')

  return (
    <IconButton
      asChild
      variant="ghost"
      size="sm"
      className="size-[33px] rounded-[10px] text-muted-foreground hover:bg-foreground/[.04] hover:text-foreground dark:hover:bg-white/[.05]"
      title={label}
      aria-label={label}
    >
      <Link href={href}>
        <PlugZap className="size-4" />
      </Link>
    </IconButton>
  )
}
