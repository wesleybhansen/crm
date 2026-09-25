import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { ApplyBreadcrumb } from '@open-mercato/ui/backend/AppShell'

// The page is a client component, so its tab title and header crumb live here.
export const metadata: Metadata = { title: 'Welcome' }

export default function WelcomeLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ApplyBreadcrumb title="Welcome" />
      {children}
    </>
  )
}
