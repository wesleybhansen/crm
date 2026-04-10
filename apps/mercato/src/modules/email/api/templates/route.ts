/**
 * Email style templates CRUD.
 *
 * Replaces the collision route at apps/mercato/src/app/api/email/templates/route.ts.
 * Same URL: /api/email/templates (auto-discovered from email module api/templates/).
 *
 * Custom route (not makeCrudRoute) because of:
 * - Lazy seeding of 10 default templates on first access
 * - categoryColor enrichment on GET
 * - Hard delete (not soft) for non-default templates
 * - Default template deletion guard
 */
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { EmailStyleTemplate } from '../../data/schema'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { z } from 'zod'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['email.templates.view'] },
  POST: { requireAuth: true, requireFeatures: ['email.templates.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['email.templates.manage'] },
}

// ── Default template HTML builders ──────────────────────────────────

function wrapEmail(preheaderColor: string, bodyContent: string): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="X-UA-Compatible" content="IE=edge"/>
<title></title>
<style type="text/css">
@media only screen and (max-width:620px){.wrapper{width:100%!important;padding:0 16px!important}.col{width:100%!important;display:block!important}.hero-text{font-size:22px!important}.btn-td{padding:12px 24px!important}}body,table,td,p,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table,td{mso-table-lspace:0;mso-table-rspace:0}img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}body{margin:0;padding:0;width:100%!important;background-color:#f4f4f7}
</style>
<!--[if mso]><style>table{border-collapse:collapse}td{font-family:Arial,sans-serif}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
<span style="display:none;font-size:1px;color:${preheaderColor};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden"></span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7"><tr><td align="center" style="padding:24px 0">
<table role="presentation" class="wrapper" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
${bodyContent}
</table>
</td></tr></table>
</body>
</html>`
}

const FOOTER = (pColor: string) => `
<tr><td style="padding:24px 0;text-align:center">
  <p style="margin:0;font-size:12px;color:${pColor};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:${pColor};text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:${pColor};text-decoration:underline">Unsubscribe</a></p>
</td></tr>`

const card = (inner: string, extra = '') =>
  `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb${extra}"><tr><td style="padding:40px 40px 40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">{{content}}</td></tr></table></td></tr>`

const banner = (bg: string, style = '') =>
  `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${bg};${style}border-radius:8px 8px 0 0"><tr><td style="padding:20px 40px">&nbsp;</td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none"><tr><td style="padding:40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">{{content}}</td></tr></table></td></tr>`

const DEFAULT_TEMPLATES: Array<{ name: string; category: string; html_template: string }> = [
  { name: 'Clean', category: 'newsletter', html_template: wrapEmail('#f4f4f7', card('') + FOOTER('#6b7280')) },
  { name: 'Bold', category: 'announcement', html_template: wrapEmail('#1e293b', banner('{{brand_primary}}') + FOOTER('#9ca3af')) },
  { name: 'Showcase', category: 'product', html_template: wrapEmail('#f4f4f7', banner('{{brand_primary}}', 'background:linear-gradient(135deg,{{brand_primary}},{{brand_secondary}});') + FOOTER('#9ca3af')) },
  { name: 'Friendly', category: 'onboarding', html_template: wrapEmail('#f4f4f7', `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb"><tr><td style="padding:12px 40px;background-color:#fefce8;border-bottom:1px solid #fde68a">&nbsp;</td></tr><tr><td style="padding:32px 40px 40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">{{content}}</td></tr></table></td></tr>` + FOOTER('#9ca3af')) },
  { name: 'Vibrant', category: 'promotion', html_template: wrapEmail('#f4f4f7', banner('#dc2626') + FOOTER('#9ca3af')) },
  { name: 'Elegant', category: 'event', html_template: wrapEmail('#f4f4f7', `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb"><tr><td style="padding:12px;border-bottom:3px solid #0ea5e9">&nbsp;</td></tr><tr><td style="padding:32px 40px 40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">{{content}}</td></tr></table></td></tr>` + FOOTER('#9ca3af')) },
  { name: 'Warm', category: 'social-proof', html_template: wrapEmail('#f4f4f7', card('', ';border-top:4px solid #10b981') + FOOTER('#9ca3af')) },
  { name: 'Professional', category: 'educational', html_template: wrapEmail('#f4f4f7', card('', ';border-left:5px solid #6366f1') + FOOTER('#9ca3af')) },
  { name: 'Festive', category: 'seasonal', html_template: wrapEmail('#f4f4f7', banner('#059669', 'background:linear-gradient(135deg,#059669,#047857);') + FOOTER('#9ca3af')) },
  { name: 'Simple', category: 'general', html_template: wrapEmail('#ffffff', `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px;font-size:15px;line-height:1.7;color:#374151;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">{{content}}</td></tr></table></td></tr><tr><td style="padding:16px 40px;text-align:center;border-top:1px solid #e5e7eb"><p style="margin:0;font-size:12px;color:#9ca3af;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><a href="{{preference_url}}" style="color:#9ca3af;text-decoration:underline">Preferences</a> &bull; <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p></td></tr>`) },
]

const CATEGORY_COLORS: Record<string, string> = {
  newsletter: '#3B82F6', announcement: '#1E293B', product: '#8B5CF6',
  onboarding: '#F59E0B', promotion: '#DC2626', event: '#0EA5E9',
  'social-proof': '#10B981', educational: '#6366F1', seasonal: '#059669', general: '#6B7280',
}

async function seedDefaults(em: EntityManager, tenantId: string, orgId: string) {
  const crypto = require('crypto')
  for (const t of DEFAULT_TEMPLATES) {
    const s = em.create(EmailStyleTemplate, {
      id: crypto.randomUUID(),
      tenantId,
      organizationId: orgId,
      name: t.name,
      category: t.category,
      htmlTemplate: t.html_template,
      isDefault: true,
    })
    em.persist(s)
  }
  await em.flush()
}

function serialize(t: EmailStyleTemplate) {
  return {
    id: t.id,
    tenant_id: t.tenantId,
    organization_id: t.organizationId,
    name: t.name,
    category: t.category,
    html_template: t.htmlTemplate,
    is_default: t.isDefault,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    categoryColor: CATEGORY_COLORS[t.category ?? ''] || CATEGORY_COLORS.general,
  }
}

// ── Handlers ────────────────────────────────────────────────────────

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    let templates = await em.find(
      EmailStyleTemplate,
      { organizationId: auth.orgId, tenantId: auth.tenantId },
      { orderBy: { category: 'asc', name: 'asc' } },
    )

    if (templates.length === 0) {
      await seedDefaults(em, auth.tenantId, auth.orgId)
      templates = await em.find(
        EmailStyleTemplate,
        { organizationId: auth.orgId, tenantId: auth.tenantId },
        { orderBy: { category: 'asc', name: 'asc' } },
      )
    }

    return NextResponse.json({ ok: true, data: templates.map(serialize) })
  } catch (error) {
    console.error('[email.templates.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load templates' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const { name, category, htmlTemplate } = body
    if (!name || !htmlTemplate) {
      return NextResponse.json({ ok: false, error: 'name and htmlTemplate required' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const crypto = require('crypto')

    const t = em.create(EmailStyleTemplate, {
      id: crypto.randomUUID(),
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
      name,
      category: category || 'general',
      htmlTemplate,
      isDefault: false,
    })
    em.persist(t)
    await em.flush()

    return NextResponse.json({ ok: true, data: { id: t.id } }, { status: 201 })
  } catch (error) {
    console.error('[email.templates.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create template' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const t = await em.findOne(EmailStyleTemplate, {
      id,
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
    })
    if (!t) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
    if (t.isDefault) return NextResponse.json({ ok: false, error: 'Cannot delete default templates' }, { status: 403 })

    await em.removeAndFlush(t)
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.templates.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete template' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Email style templates',
  description: 'CRUD for email style templates. Auto-seeds 10 default templates on first access. Default templates cannot be deleted.',
  methods: {
    GET: { summary: 'List templates', tags: ['Email'], responses: [{ status: 200, description: 'Template list', schema: z.object({ ok: z.literal(true), data: z.array(z.any()) }) }] },
    POST: { summary: 'Create template', tags: ['Email'], responses: [{ status: 201, description: 'Created', schema: z.object({ ok: z.literal(true), data: z.object({ id: z.string() }) }) }] },
    DELETE: { summary: 'Delete template', tags: ['Email'], responses: [{ status: 200, description: 'Deleted', schema: z.object({ ok: z.literal(true) }) }] },
  },
}
