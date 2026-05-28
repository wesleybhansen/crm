"use client"

import { useEffect } from 'react'
import posthog from 'posthog-js'

type GlobalErrorProps = {
  error: Error & { digest?: string }
  reset: () => void
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    // global-error renders outside the layout, so PostHogProvider isn't in
    // scope and we can't re-init here (the CRM has no NEXT_PUBLIC_* key in the
    // client bundle — it's injected at runtime via props). Capture only if a
    // prior page already loaded PostHog, which covers the common case.
    if (posthog.__loaded) {
      posthog.captureException(error, {
        $error_boundary: 'global-error',
        $error_digest: error.digest,
        $error_app: 'crm',
      })
    }
  }, [error])

  return (
    <html>
      <body>
        <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
          <h1>Something went wrong</h1>
          <p>An unexpected error occurred while rendering this page.</p>
          <button type="button" onClick={() => reset()}>
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}
