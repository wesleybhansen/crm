import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET) that lets the
 * hub's Unified Inbox manage AUDIENCES (inbox_audiences): named groups of people
 * ("My team", "Customers", …) defined by email addresses/domains, a CRM list, or a
 * contact stage, each carrying an action the drafters apply by sender identity
 * (no_draft / pause / auto_send / none). Both drafters (inbox/process +
 * customer-service/process) read these via lib/audiences.ts. Keyed by the noli user
 * id like the other internal endpoints. */

export const metadata = {
  path: '/internal/inbox-audiences',
  POST: { requireAuth: false },
}

const VALID_ACTIONS = new Set(['none', 'no_draft', 'pause', 'auto_send'])
const MAX_EMAILS = 1000
const MAX_STAGES = 50

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

type Auth = { userId: string; orgId: string; tenantId: string }

async function resolveAuth(noliUserId: string): Promise<Auth | null> {
  const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
  const noliUser = await findNoliUserById(noliUserId)
  if (!noliUser?.clerk_user_id) return null
  const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
  const a = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
  if (!a?.userId || !a?.orgId || !a?.tenantId) return null
  return { userId: String(a.userId), orgId: String(a.orgId), tenantId: String(a.tenantId) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Knex = any

function normEmails(raw: unknown): string[] {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
    ? raw.split(/[\s,;\n]+/)
    : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of arr) {
    const s = String(v || '').trim().toLowerCase()
    // Accept a full address (has @ and a dot after it) or a bare domain (@example.com).
    const ok = s.startsWith('@') ? /^@[^@\s]+\.[^@\s]+$/.test(s) : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)
    if (ok && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
    if (out.length >= MAX_EMAILS) break
  }
  return out
}

function normStages(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of arr) {
    const s = String(v || '').trim().toLowerCase()
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
    if (out.length >= MAX_STAGES) break
  }
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialize(row: Record<string, any>) {
  const parse = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((x) => String(x))
    if (typeof v === 'string') {
      try {
        const p = JSON.parse(v)
        return Array.isArray(p) ? p.map((x) => String(x)) : []
      } catch {
        return []
      }
    }
    return []
  }
  return {
    id: String(row.id),
    name: String(row.name || ''),
    action: VALID_ACTIONS.has(row.action) ? row.action : 'no_draft',
    emails: parse(row.emails),
    crmListId: row.crm_list_id ? String(row.crm_list_id) : null,
    contactStages: parse(row.contact_stages),
    isDefaultTeam: row.is_default_team === true,
  }
}

async function listAll(knex: Knex, auth: Auth) {
  const rows = await knex('inbox_audiences').where('organization_id', auth.orgId).orderBy('created_at', 'asc')
  const audiences = (rows as Record<string, unknown>[]).map(serialize)

  // Available CRM lists to link an audience to.
  let crmLists: { id: string; name: string; memberCount: number }[] = []
  try {
    const lrows = await knex('email_lists')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .orderBy('name', 'asc')
      .limit(200)
      .select('id', 'name', 'member_count')
    crmLists = (lrows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name || ''),
      memberCount: Number(r.member_count || 0),
    }))
  } catch {
    crmLists = []
  }

  // Distinct contact stages in this org (for the "by contact type" picker).
  let contactStages: string[] = []
  try {
    const srows = await knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereNotNull('lifecycle_stage')
      .distinct('lifecycle_stage')
      .limit(100)
      .pluck('lifecycle_stage')
    const seen = new Set<string>()
    for (const s of srows as string[]) {
      const v = String(s || '').trim()
      const key = v.toLowerCase()
      if (v && !seen.has(key)) {
        seen.add(key)
        contactStages.push(v)
      }
    }
    contactStages.sort((a, b) => a.localeCompare(b))
  } catch {
    contactStages = []
  }

  return { audiences, crmLists, contactStages }
}

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const op = typeof body.op === 'string' ? body.op : ''
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!op || !noliUserId) return NextResponse.json({ ok: false, error: 'op and noliUserId are required' }, { status: 400 })

  try {
    const auth = await resolveAuth(noliUserId)
    if (!auth) return NextResponse.json({ ok: false, error: 'no CRM account for this user' }, { status: 404 })
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex() as Knex

    if (op === 'list') {
      return NextResponse.json({ ok: true, data: await listAll(knex, auth) })
    }

    if (op === 'seed') {
      // Ensure the ready-made "My team" audience exists (don't-draft, empty until
      // the user adds their teammates' addresses). Idempotent.
      const existing = await knex('inbox_audiences').where('organization_id', auth.orgId).where('is_default_team', true).first()
      if (!existing) {
        await knex('inbox_audiences').insert({
          id: crypto.randomUUID(),
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          name: 'My team',
          action: 'no_draft',
          emails: JSON.stringify([]),
          contact_stages: JSON.stringify([]),
          is_default_team: true,
        })
      }
      return NextResponse.json({ ok: true, data: await listAll(knex, auth) })
    }

    if (op === 'add') {
      const name = String(body.name || '').trim().slice(0, 120)
      if (!name) return NextResponse.json({ ok: false, error: 'A name is required' }, { status: 400 })
      const action = VALID_ACTIONS.has(String(body.action)) ? String(body.action) : 'no_draft'
      const emails = normEmails(body.emails)
      const stages = normStages(body.contactStages)
      const crmListId = typeof body.crmListId === 'string' && body.crmListId ? body.crmListId : null
      const id = crypto.randomUUID()
      await knex('inbox_audiences').insert({
        id,
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        name,
        action,
        emails: JSON.stringify(emails),
        crm_list_id: crmListId,
        contact_stages: JSON.stringify(stages),
        is_default_team: false,
      })
      return NextResponse.json({ ok: true, data: await listAll(knex, auth) })
    }

    if (op === 'update') {
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
      const existing = await knex('inbox_audiences').where('id', id).where('organization_id', auth.orgId).first()
      if (!existing) return NextResponse.json({ ok: false, error: 'Audience not found' }, { status: 404 })
      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (typeof body.name === 'string' && body.name.trim() && !existing.is_default_team) patch.name = body.name.trim().slice(0, 120)
      if (VALID_ACTIONS.has(String(body.action))) patch.action = String(body.action)
      if (body.emails !== undefined) patch.emails = JSON.stringify(normEmails(body.emails))
      if (body.contactStages !== undefined) patch.contact_stages = JSON.stringify(normStages(body.contactStages))
      if (body.crmListId !== undefined) patch.crm_list_id = typeof body.crmListId === 'string' && body.crmListId ? body.crmListId : null
      await knex('inbox_audiences').where('id', id).where('organization_id', auth.orgId).update(patch)
      return NextResponse.json({ ok: true, data: await listAll(knex, auth) })
    }

    if (op === 'delete') {
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
      // The default "My team" audience can be emptied but not deleted (keeps the
      // headline rule discoverable).
      await knex('inbox_audiences').where('id', id).where('organization_id', auth.orgId).where('is_default_team', false).del()
      return NextResponse.json({ ok: true, data: await listAll(knex, auth) })
    }

    return NextResponse.json({ ok: false, error: 'unknown op' }, { status: 400 })
  } catch (error) {
    console.error('[internal.inbox-audiences]', op, error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
