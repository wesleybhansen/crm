// ORM-SKIP: reads the raw sms_opt_outs table (org + tenant scoped)
export const metadata = { path: '/sms/opt-out', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findContactSmsOptOut, findSmsOptOut, smsOptOutJson } from '@/modules/customers/lib/sms-opt-outs'

/*
 * Has this contact (or number) opted out of the business's texts? The
 * contact record shows "Texts: opted out on <date>" from this, and the text
 * composer blocks sending. ?contactId=<id> checks the contact's mobile number;
 * ?phone=<number> checks a number. Scoped to the caller's organization and
 * tenant; the phone number itself is never echoed back.
 */
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const url = new URL(req.url)
    const contactId = (url.searchParams.get('contactId') || '').trim()
    const phone = (url.searchParams.get('phone') || '').trim()
    if (!contactId && !phone) return NextResponse.json({ ok: false, error: 'contactId or phone required' }, { status: 400 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const scope = { organizationId: auth.orgId, tenantId: auth.tenantId }

    const optOut = contactId
      ? (await findContactSmsOptOut(knex, scope, contactId)).optOut
      : await findSmsOptOut(knex, scope, [phone])
    const json = smsOptOutJson(optOut)
    return NextResponse.json({ ok: true, data: { optedOut: !!json, ...(json ?? {}) } })
  } catch (error) {
    console.error('[sms.opt-out]', error instanceof Error ? error.message : error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'SMS',
  summary: 'Text opt-out status',
  methods: {
    GET: { summary: 'Whether a contact or number opted out of the business texts, and when', tags: ['SMS'] },
  },
}
