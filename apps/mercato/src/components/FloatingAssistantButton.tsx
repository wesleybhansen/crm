'use client'

import { usePathname } from 'next/navigation'
import { AiAssistantWidget } from './AiAssistantWidget'

/**
 * Renders the in-page Scout widget (FAB + drawer). Suppresses itself on the
 * dedicated /backend/assistant page so you don't get a widget floating on
 * top of the full-page assistant.
 */
export function FloatingAssistantButton() {
  const pathname = usePathname()
  if (pathname === '/backend/assistant' || pathname?.startsWith('/backend/assistant/')) return null
  return <AiAssistantWidget />
}
