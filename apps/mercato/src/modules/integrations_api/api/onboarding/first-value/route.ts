import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { EmailTemplate } from '@/modules/email/data/schema'

export const metadata = {
  path: '/onboarding/first-value',
  GET: { requireAuth: true },
}

export const openApi = {
  tag: 'Onboarding',
  summary: 'Get the current organization first-value artifact',
  methods: { GET: { summary: 'Get the seeded follow-up draft', tags: ['Onboarding'] } },
}

const FIRST_VALUE_TEMPLATE = 'Follow-up: new inquiry (drafted by your Noli team)'

function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000)
}

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId || !auth?.tenantId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const template = await em.findOne(EmailTemplate, {
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
      name: FIRST_VALUE_TEMPLATE,
      deletedAt: null,
    })
    if (!template) return NextResponse.json({ ok: true, data: null })

    return NextResponse.json({
      ok: true,
      data: {
        kind: 'follow_up_draft',
        ready: true,
        id: template.id,
        subject: template.subject.slice(0, 200),
        body: plainText(template.bodyHtml),
      },
    })
  } catch (error) {
    console.error('[onboarding.first-value]', error)
    return NextResponse.json({ ok: false, error: 'Could not load your first draft' }, { status: 500 })
  }
}
