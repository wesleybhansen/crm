import type { Metadata } from 'next'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'

export async function resolveLocalizedAppMetadata(): Promise<Metadata> {
  const { t } = await resolveTranslations()
  return {
    title: t('app.metadata.title', 'Noli CRM'),
    description: t(
      'app.metadata.description',
      'The all-in-one operating system for your business',
    ),
  }
}

export async function resolveLocalizedTitleMetadata(input: {
  title?: string | null
  titleKey?: string | null
  fallback?: string
}): Promise<Metadata> {
  // A route with no title of its own inherits the layout's title (the
  // backend layout supplies "Noli CRM" and the "<Page> | Noli CRM"
  // template), so the tab never reads "Noli CRM | Noli CRM".
  if (!input.title && !input.titleKey && !input.fallback) return {}
  const { t } = await resolveTranslations()
  const fallbackTitle = input.title || input.fallback || 'Noli CRM'
  return {
    title: input.titleKey ? t(input.titleKey, fallbackTitle) : fallbackTitle,
  }
}
