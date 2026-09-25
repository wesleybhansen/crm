import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { ApplyBreadcrumb } from '@open-mercato/ui/backend/AppShell'

// The page is a client component, so its tab title and header crumb live here.
export const metadata: Metadata = { title: 'Admin Panel' }

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ApplyBreadcrumb title="Admin Panel" />
      {children}
    </>
  )
}
