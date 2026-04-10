export const metadata = { POST: { requireAuth: false } }
export const openApi = { summary: 'Email intelligence cron trigger', methods: {} }
/**
 * Inbox Intelligence Cron Trigger
 * POST: Called by external cron (1-2x daily). Syncs all enabled orgs/users.
 * Secured by CRON_SECRET env var.
 */
import { NextResponse } from 'next/server'
import { query } from '@/app/api/funnels/db'
import { runSync } from '../intelligence-sync/route'

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: 'Cron not configured' }, { status: 500 })
  }

  // Check authorization header or query param
  const authHeader = req.headers.get('authorization')
  const url = new URL(req.url)
  const querySecret = url.searchParams.get('secret')
  const providedSecret = authHeader?.replace('Bearer ', '') || querySecret

  if (providedSecret !== cronSecret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // Find all users with email intelligence enabled
  const enabledSettings = await query(
    `SELECT tenant_id, organization_id, user_id FROM email_intelligence_settings WHERE is_enabled = true`
  )

  if (enabledSettings.length === 0) {
    return NextResponse.json({ ok: true, data: { message: 'No users with email intelligence enabled', synced: 0 } })
  }

  const results: Array<{
    userId: string
    orgId: string
    emailsProcessed: number
    contactsCreated: number
    errors: string[]
  }> = []

  for (const setting of enabledSettings) {
    try {
      const result = await runSync(setting.tenant_id, setting.organization_id, setting.user_id)
      results.push({
        userId: setting.user_id,
        orgId: setting.organization_id,
        ...result,
      })
    } catch (err: any) {
      results.push({
        userId: setting.user_id,
        orgId: setting.organization_id,
        emailsProcessed: 0,
        contactsCreated: 0,
        errors: [err.message || 'Unknown error'],
      })
    }
  }

  const totalEmails = results.reduce((sum, r) => sum + r.emailsProcessed, 0)
  const totalContacts = results.reduce((sum, r) => sum + r.contactsCreated, 0)
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0)

  return NextResponse.json({
    ok: true,
    data: {
      synced: results.length,
      totalEmails,
      totalContacts,
      totalErrors,
      results,
    },
  })
}
