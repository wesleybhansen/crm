'use client'
import Link from 'next/link'
import { Settings } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { IconButton } from '../primitives/icon-button'

export type SettingsButtonProps = {
  href?: string
}

export function SettingsButton({ href = '/backend/settings' }: SettingsButtonProps) {
  const t = useT()

  return (
    <IconButton
      asChild
      variant="ghost"
      size="sm"
      className="size-[33px] rounded-[10px] text-muted-foreground hover:bg-foreground/[.04] hover:text-foreground dark:hover:bg-white/[.05]"
      title={t('backend.nav.settings', 'Settings')}
    >
      <Link href={href}>
        <Settings className="size-4" />
      </Link>
    </IconButton>
  )
}
