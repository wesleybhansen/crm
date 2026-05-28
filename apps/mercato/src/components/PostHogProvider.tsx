"use client"

import { useEffect, Suspense } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useUser } from '@clerk/nextjs'
import posthog from 'posthog-js'

/* PostHog for the CRM (crm.noliai.com) — build-queue 5.3/S.4, the 6th and
 * final surface to get analytics + error tracking.
 *
 * CRM-specific differences from the hub/marketing providers:
 *   - The key arrives as a PROP, not from process.env in the browser. The
 *     Hetzner Docker build has no NEXT_PUBLIC_* vars at build time, so they
 *     never get inlined into the client bundle. The root layout is
 *     force-dynamic and reads process.env at request time (same mechanism
 *     Clerk's publishableKey relies on), then threads the value down here.
 *   - No cookie-consent gating: the CRM is authenticated paid software with
 *     no consent banner (essential cookies only), so we opt in directly.
 *   - session_recording masks all inputs — a CRM holds customer PII, so we
 *     keep navigation/click/rage-click replay but never capture typed values.
 *   - Registers `$app: 'crm'` as a super-property so every event is filterable
 *     by source alongside the other five surfaces. */

function PostHogPageview() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    if (!pathname) return
    if (!posthog.__loaded) return
    const url =
      searchParams && searchParams.toString()
        ? `${pathname}?${searchParams.toString()}`
        : pathname
    posthog.capture('$pageview', { $current_url: window.location.origin + url })
  }, [pathname, searchParams])

  return null
}

function PostHogIdentify() {
  const { isLoaded, isSignedIn, user } = useUser()

  useEffect(() => {
    if (!posthog.__loaded || !isLoaded) return
    if (isSignedIn && user) {
      const email =
        user.primaryEmailAddress?.emailAddress ??
        user.emailAddresses?.[0]?.emailAddress
      const name =
        [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined
      posthog.identify(user.id, {
        email,
        name,
        clerk_user_id: user.id,
      })
    } else {
      posthog.reset()
    }
  }, [isLoaded, isSignedIn, user])

  return null
}

export function PostHogProvider({
  children,
  posthogKey,
  posthogHost,
}: {
  children: React.ReactNode
  posthogKey?: string
  posthogHost?: string
}) {
  useEffect(() => {
    if (!posthogKey) return
    if (posthog.__loaded) return

    posthog.init(posthogKey, {
      api_host: posthogHost || 'https://us.i.posthog.com',
      capture_pageview: false,
      person_profiles: 'identified_only',
      autocapture: true,
      session_recording: { maskAllInputs: true },
      /* Auto-capture unhandled client errors + promise rejections. React
       * render errors caught by global-error.tsx call captureException
       * explicitly there. */
      capture_exceptions: true,
    })
    posthog.register({ $app: 'crm' })
  }, [posthogKey, posthogHost])

  return (
    <>
      <Suspense fallback={null}>
        <PostHogPageview />
      </Suspense>
      <PostHogIdentify />
      {children}
    </>
  )
}
