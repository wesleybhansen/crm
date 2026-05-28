"use client"

import type { ReactNode } from 'react'
import type { Locale } from '@open-mercato/shared/lib/i18n/config'
import type { Dict } from '@open-mercato/shared/lib/i18n/context'
import { I18nProvider } from '@open-mercato/shared/lib/i18n/context'
import { ThemeProvider, FrontendLayout, QueryProvider, AuthFooter } from '@open-mercato/ui'
import { ClientBootstrapProvider } from '@/components/ClientBootstrap'
import { GlobalNoticeBars } from '@/components/GlobalNoticeBars'
import { PostHogProvider } from '@/components/PostHogProvider'

type AppProvidersProps = {
  children: ReactNode
  locale: Locale
  dict: Dict
  demoModeEnabled: boolean
  // PostHog key/host are read server-side at runtime in the layout (the
  // Docker build has no NEXT_PUBLIC_* vars) and threaded down here.
  posthogKey?: string
  posthogHost?: string
}

export function AppProviders({ children, locale, dict, demoModeEnabled, posthogKey, posthogHost }: AppProvidersProps) {
  return (
    <I18nProvider locale={locale} dict={dict}>
      <PostHogProvider posthogKey={posthogKey} posthogHost={posthogHost}>
        <ClientBootstrapProvider>
          <ThemeProvider>
            <QueryProvider>
              <FrontendLayout footer={null}>{children}</FrontendLayout>
              <GlobalNoticeBars demoModeEnabled={demoModeEnabled} />
            </QueryProvider>
          </ThemeProvider>
        </ClientBootstrapProvider>
      </PostHogProvider>
    </I18nProvider>
  )
}
