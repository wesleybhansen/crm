import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import {
  decideIntakeGate,
  readLaunchpadBriefing,
  type LaunchpadBriefing,
  type NoliCoreReader,
} from '../../../lib/intake-gate'

export const metadata = {
  path: '/onboarding/intake-gate',
  GET: { requireAuth: true },
}

export const openApi = {
  tag: 'Onboarding',
  summary: 'Whether the member should see the About Your Business intake',
  methods: { GET: { summary: 'Decide dashboard, intake, or awaiting the Ideation Lab', tags: ['Onboarding'] } },
}

/*
 * The dashboard and the welcome wizard ask this before showing the intake
 * (product audit 2026-09-25, D6). The profile is read for the caller's own
 * organization and tenant only; the Launch Pad state is read for the
 * signed-in noli user only.
 */
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId || !auth?.tenantId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const { CustomerBusinessProfile } = await import('@open-mercato/core/modules/customers/data/entities')
    const bp = await em.findOne(CustomerBusinessProfile, {
      organizationId: auth.orgId as string,
      tenantId: auth.tenantId as string,
    })
    const profile = bp
      ? {
          onboarding_complete: bp.onboardingComplete ?? null,
          seeded_by: bp.seededBy ?? null,
          business_description: bp.businessDescription ?? null,
        }
      : null

    let launchpad: LaunchpadBriefing = null
    const noliUserId = typeof auth.noliUserId === 'string' ? auth.noliUserId : ''
    // Only worth a noli-core read when the intake would otherwise show.
    if (noliUserId && decideIntakeGate(profile, null) === 'intake') {
      try {
        const { getNoliCoreClient } = await import('@open-mercato/shared/lib/noli/core-client')
        launchpad = await readLaunchpadBriefing(getNoliCoreClient() as unknown as NoliCoreReader, noliUserId)
      } catch {
        launchpad = null
      }
    }

    return NextResponse.json({ ok: true, data: { gate: decideIntakeGate(profile, launchpad) } })
  } catch (err) {
    console.error('[onboarding.intake-gate]', err)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
