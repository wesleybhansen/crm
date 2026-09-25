import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { Knex } from 'knex'
import type { EntityManager } from '@mikro-orm/postgresql'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { meterCustomersAi } from '@/lib/usage/meter'
import { geminiGenerationConfig, geminiUsage } from '@/lib/ai/gemini'
import {
  CANDIDATE_PREVIEW,
  FAIR_HOUSING_REASON,
  MAX_DAILY_CAP,
  MAX_DRAFTS_PER_CALL,
  QUIET_DAYS,
  REACTIVATION_KINDS,
  REACTIVATION_MARKER,
  REACTIVATION_SOURCE,
  REVIEW_LINK_MISSING_NOTICE,
  WON_DEAL_MIN_AGE_DAYS,
  applyReviewLink,
  buildReactivationPrompt,
  candidateReason,
  clampLimit,
  deterministicId,
  isSuppressed,
  isUuid,
  parseDraft,
  pastClientStageList,
  reviewLinkFromProfile,
  screenReactivationDraft,
  slotsLeftToday,
  utcDayStart,
  type ReactivationKind,
  type SuppressionLists,
} from '../../../lib/reactivation'

/*
 * Internal server-to-server endpoint for the Chief of Staff's past-client
 * reactivation initiative. The Noli hub calls it with the shared
 * NOLI_INTERNAL_SERVICE_SECRET. Ops:
 *   candidates  who qualifies (read only)
 *   draft       drafts personal notes as inbox proposals (never sends); each
 *               note passes the fair-housing screen, and one that fails is
 *               kept for the owner to see, with the reason, but never sendable.
 *               A review_request note carries the business's saved review
 *               link (Reputation page); with none saved it mentions no link
 *               and the response and approval card say where to add one
 *   approve     the owner approved the initiative in the hub: pending drafts
 *               for it become sendable
 *   send-batch  sends approved drafts, at most the daily cap per UTC day,
 *               through the owner's own connected mailbox, re-checking every
 *               opt-out right before each send
 * Every op is scoped to the org resolved from noliUserId; nothing is read or
 * written across organizations.
 */
export const dynamic = 'force-dynamic'
export const metadata = {
  path: '/internal/reactivation',
  POST: { requireAuth: false },
}

const DRAFT_MODEL = 'gemini-2.5-flash'
const DRAFT_CONCURRENCY = 5
const DAY_MS = 24 * 60 * 60 * 1000

type Auth = { userId: string; orgId: string; tenantId: string }
type Row = Record<string, any>

function unauthorized(req: Request): boolean {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const header = (req.headers.get('authorization') || '').trim()
  const digest = (v: string) => crypto.createHash('sha256').update(v).digest()
  return !secret || !crypto.timingSafeEqual(digest(header), digest(`Bearer ${secret}`))
}

async function resolveAuth(noliUserId: string): Promise<Auth | null> {
  const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
  const noliUser = await findNoliUserById(noliUserId)
  if (!noliUser?.clerk_user_id) return null
  const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
  const a = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
  if (!a?.userId || !a?.orgId || !a?.tenantId) return null
  return { userId: String(a.userId), orgId: String(a.orgId), tenantId: String(a.tenantId) }
}

function parseJson(value: unknown): Row {
  if (value && typeof value === 'object') return value as Row
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Decrypt contact rows read through raw knex. A row whose name or email is still
 *  an encrypted envelope afterwards is dropped (and counted), never returned. */
async function decryptContacts(em: EntityManager, auth: Auth, rows: Row[]): Promise<{ rows: Row[]; undecryptable: number }> {
  for (const row of rows) row.stored_email = row.primary_email
  const { decryptRowFields, CONTACT_ENTITY_KEY } = await import('@open-mercato/shared/lib/encryption/decryptRows')
  const { isEncryptedEnvelope } = await import('@open-mercato/shared/lib/encryption/aes')
  await decryptRowFields(em, CONTACT_ENTITY_KEY, rows, ['display_name', 'primary_email'], auth.tenantId, auth.orgId)
  const ok = rows.filter((row) => !isEncryptedEnvelope(row.primary_email) && !isEncryptedEnvelope(row.display_name))
  return { rows: ok, undecryptable: rows.length - ok.length }
}

/** Fails closed: an unreadable suppression list throws, so nothing is sent or drafted. */
async function loadSuppressions(knex: Knex, auth: Auth, now: Date): Promise<SuppressionLists> {
  const unsub = await knex('email_unsubscribes').where('organization_id', auth.orgId).select('email')
  const suppressed = await knex('gtm_suppressions')
    .whereNull('deleted_at')
    .whereIn('channel', ['email', 'all'])
    .where((q) => q.where((o) => o.where('organization_id', auth.orgId).where('tenant_id', auth.tenantId)).orWhere('scope', 'global'))
    .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now))
    .select('address_hash')
  return {
    unsubscribed: new Set(unsub.map((r: Row) => String(r.email ?? '').trim().toLowerCase()).filter(Boolean)),
    suppressedHashes: new Set(suppressed.map((r: Row) => String(r.address_hash))),
  }
}

/** Past clients with an email, quiet for QUIET_DAYS, not opted out. */
async function findCandidates(knex: Knex, em: EntityManager, auth: Auth, now: Date, excludeContactIds: Set<string>) {
  const quietSince = new Date(now.getTime() - QUIET_DAYS * DAY_MS)
  const wonBefore = new Date(now.getTime() - WON_DEAL_MIN_AGE_DAYS * DAY_MS)
  const rows = (await knex('customer_entities as ce')
    .where('ce.organization_id', auth.orgId)
    .where('ce.tenant_id', auth.tenantId)
    .where('ce.kind', 'person')
    .whereNull('ce.deleted_at')
    .whereNotNull('ce.primary_email')
    .where((q) =>
      q
        .whereRaw(`lower(trim(coalesce(ce.lifecycle_stage, ''))) = any(?)`, [pastClientStageList()])
        .orWhereExists(
          knex('customer_deal_people as cdp')
            .join('customer_deals as cd', 'cd.id', 'cdp.deal_id')
            .whereRaw('cdp.person_entity_id = ce.id')
            .where('cd.organization_id', auth.orgId)
            .where('cd.status', 'won')
            .whereNull('cd.deleted_at')
            .where('cd.updated_at', '<', wonBefore),
        ),
    )
    .whereNotExists(
      knex('email_messages as em')
        .whereRaw('em.contact_id = ce.id')
        .where('em.organization_id', auth.orgId)
        .where('em.direction', 'outbound')
        .where('em.created_at', '>', quietSince),
    )
    .orderBy('ce.id', 'asc')
    .limit(1000)
    .select(
      'ce.id',
      'ce.display_name',
      'ce.primary_email',
      'ce.lifecycle_stage',
      knex.raw('(select max(m.created_at) from email_messages m where m.contact_id = ce.id and m.organization_id = ce.organization_id) as last_contact_at'),
    )) as Row[]
  const fresh = rows.filter((row) => !excludeContactIds.has(String(row.id)))
  const { rows: readable, undecryptable } = await decryptContacts(em, auth, fresh)
  const lists = await loadSuppressions(knex, auth, now)
  const eligible = readable.filter((row) => !isSuppressed(String(row.primary_email ?? ''), row.stored_email, lists))
  return { eligible, undecryptable, suppressed: readable.length - eligible.length }
}

function reactivationActions(knex: Knex, auth: Auth) {
  return knex('inbox_proposal_actions')
    .where('organization_id', auth.orgId)
    .where('tenant_id', auth.tenantId)
    .where('action_type', 'draft_reply')
    .whereRaw(`metadata->>'feature_source' = ?`, [REACTIVATION_SOURCE])
}

async function opCandidates(knex: Knex, em: EntityManager, auth: Auth) {
  const { eligible, undecryptable, suppressed } = await findCandidates(knex, em, auth, new Date(), new Set())
  return {
    ok: true,
    count: eligible.length,
    suppressed,
    undecryptable,
    candidates: eligible.slice(0, CANDIDATE_PREVIEW).map((row) => ({
      id: String(row.id),
      displayName: row.display_name || null,
      lastContactAt: row.last_contact_at ? new Date(row.last_contact_at).toISOString() : null,
      reason: candidateReason(row.lifecycle_stage),
    })),
  }
}

async function generateDraft(apiKey: string, prompt: string) {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${DRAFT_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: geminiGenerationConfig({ temperature: 0.7, maxOutputTokens: 2048, responseMimeType: 'application/json' }),
      }),
      signal: AbortSignal.timeout(25_000),
    })
    if (!r.ok) return { draft: null, tokensIn: 0, tokensOut: 0 }
    const data = (await r.json()) as Row
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: Row) => p.text ?? '').join('')
    const usage = geminiUsage(data as never)
    return { draft: parseDraft(text), tokensIn: usage.tokensIn ?? 0, tokensOut: usage.tokensOut ?? 0 }
  } catch {
    return { draft: null, tokensIn: 0, tokensOut: 0 }
  }
}

async function opDraft(knex: Knex, em: EntityManager, auth: Auth, noliUserId: string, body: Row) {
  const initiativeId = body.initiativeId
  const kind = body.kind as ReactivationKind
  if (!isUuid(initiativeId)) return { status: 400, json: { ok: false, error: 'initiativeId (uuid) required' } }
  if (!REACTIVATION_KINDS.includes(kind)) return { status: 400, json: { ok: false, error: 'kind must be check_in, referral_ask or review_request' } }
  const limit = clampLimit(body.limit, 10, MAX_DRAFTS_PER_CALL)

  // Contacts already drafted for this initiative, or waiting on any other
  // reactivation draft, are not drafted again.
  const existing = (await reactivationActions(knex, auth)
    .where((q) => q.whereRaw(`metadata->>'initiative_id' = ?`, [initiativeId]).orWhereIn('status', ['pending', 'approved', 'sending']))
    .select(knex.raw(`metadata->>'contact_id' as contact_id`), knex.raw(`metadata->>'initiative_id' as initiative_id`), 'id')) as Row[]
  const already = existing.filter((r) => r.initiative_id === initiativeId).map((r) => String(r.id))
  const exclude = new Set(existing.map((r) => String(r.contact_id)))

  const gate = await checkCustomersAiAllowance({ orgId: auth.orgId })
  if (!gate.allowed) return { status: 200, json: { ok: true, created: [], existing: already, reason: 'allowance' } }
  const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) return { status: 200, json: { ok: true, created: [], existing: already, reason: 'no_key' } }

  const { eligible } = await findCandidates(knex, em, auth, new Date(), exclude)
  const picked = eligible.slice(0, limit)
  const bp = (await knex('business_profiles').where('organization_id', auth.orgId).first().catch(() => null)) as Row | null
  // select * (not review_url by name): the column comes from
  // scripts/sql/reputation.sql and a missing column must not break drafting.
  const reviewUrl = kind === 'review_request' ? reviewLinkFromProfile(bp) : null
  const reviewLinkNotice = kind === 'review_request' && !reviewUrl ? REVIEW_LINK_MISSING_NOTICE : null
  const business = { name: bp?.business_name || 'our team', description: bp?.business_description || '', reviewUrl }

  const created: string[] = []
  const flagged: Array<{ actionId: string; contactId: string; reason: string; advisory: string }> = []
  for (let i = 0; i < picked.length; i += DRAFT_CONCURRENCY) {
    await Promise.all(picked.slice(i, i + DRAFT_CONCURRENCY).map(async (contact) => {
      const contactId = String(contact.id)
      const name = String(contact.display_name || '').trim()
      const { draft: generated, tokensIn, tokensOut } = await generateDraft(apiKey, buildReactivationPrompt(kind, business, { name: name || 'there' }))
      void meterCustomersAi({ orgId: auth.orgId }, {
        model: DRAFT_MODEL, tokensIn, tokensOut, feature: 'initiative-reactivation', byoKey: Boolean(gate.byoApiKey), noliUserId,
      })
      if (!generated) return
      const draft = applyReviewLink(kind, generated, reviewUrl)
      // Fair-housing screen at draft time. A failing note is still recorded so
      // the owner sees it and why, but it is marked blocked and approve/send
      // never let it out.
      const screen = screenReactivationDraft(draft, name)
      const fairHousing = screen.ok
        ? { ok: true }
        : { ok: false, blocked: true, findings: screen.findings, advisory: screen.advisory }
      const now = new Date()
      const emailId = deterministicId(initiativeId, contactId, 'email')
      const proposalId = deterministicId(initiativeId, contactId, 'proposal')
      const actionId = deterministicId(initiativeId, contactId, 'action')
      const label = name || String(contact.primary_email)
      try {
        await knex.transaction(async (trx) => {
          await trx('inbox_emails').insert({
            id: emailId, tenant_id: auth.tenantId, organization_id: auth.orgId,
            forwarded_by_address: 'noli@noliai.com', to_address: contact.primary_email,
            subject: `${REACTIVATION_MARKER} ${label}`, status: 'processed', received_at: now,
            is_active: true, created_at: now, updated_at: now,
          })
          await trx('inbox_proposals').insert({
            id: proposalId, inbox_email_id: emailId, tenant_id: auth.tenantId, organization_id: auth.orgId,
            summary: screen.ok
              ? `${REACTIVATION_MARKER} ${label} is a past client you have not written to in a while. Your Chief of Staff drafted a personal note.${reviewLinkNotice ? ` ${reviewLinkNotice}` : ''}`
              : `${REACTIVATION_MARKER} ${label}: the drafted note was held and will not be sent. ${screen.advisory}`,
            participants: JSON.stringify([{ name, email: contact.primary_email }]),
            confidence: 0.75, category: 'inquiry', status: 'pending', is_active: true, created_at: now, updated_at: now,
          })
          await trx('inbox_proposal_actions').insert({
            id: actionId, proposal_id: proposalId, tenant_id: auth.tenantId, organization_id: auth.orgId,
            action_type: 'draft_reply', sort_order: 0,
            description: `Personal note to past client ${label}`,
            payload: JSON.stringify({
              to: contact.primary_email, toName: name || null, subject: draft.subject, body: draft.body, contactId,
              context: screen.ok
                ? `Drafted by your Chief of Staff for a past-client initiative. Nothing is sent until you approve it.${reviewLinkNotice ? ` ${reviewLinkNotice}` : ''}`
                : `Held, not sendable. ${screen.advisory}`,
              ...(kind === 'review_request' ? { reviewLink: reviewUrl } : {}),
            }),
            metadata: JSON.stringify({
              feature_source: REACTIVATION_SOURCE, initiative_id: initiativeId, contact_id: contactId, kind, fair_housing: fairHousing,
              ...(kind === 'review_request' ? { review_link: { included: Boolean(reviewUrl), notice: reviewLinkNotice } } : {}),
            }),
            status: 'pending', confidence: 0.75, created_at: now, updated_at: now,
          })
        })
        created.push(actionId)
        if (!screen.ok) flagged.push({ actionId, contactId, reason: FAIR_HOUSING_REASON, advisory: screen.advisory })
      } catch (err) {
        // 23505: a concurrent call for the same initiative already drafted this contact.
        if ((err as { code?: string })?.code !== '23505') throw err
      }
    }))
  }
  // review_link tells the hub's approval card whether the notes carry the
  // business's review link, and where to add one when they do not.
  return {
    status: 200,
    json: {
      ok: true, created, existing: already, flagged,
      ...(kind === 'review_request' ? { review_link: { included: Boolean(reviewUrl), notice: reviewLinkNotice } } : {}),
    },
  }
}

async function opApprove(knex: Knex, auth: Auth, body: Row) {
  const initiativeId = body.initiativeId
  if (!isUuid(initiativeId)) return { status: 400, json: { ok: false, error: 'initiativeId (uuid) required' } }
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId.slice(0, 80) : null
  const exclude = Array.isArray(body.excludeActionIds) ? body.excludeActionIds.filter(isUuid) : []
  const now = new Date()
  // Each note is screened as it reads NOW. One that fails is held: it stays
  // pending (never approved, never sent) with the reason, so the owner can
  // edit it and approve again, or decline it. It used to be dismissed, so a
  // false positive ("bachelor's degree") cost the owner the draft for good
  // (2026-09-25 review, M9). A draft-time flag on a note the owner has since
  // edited clean no longer blocks it.
  let pendingQuery = reactivationActions(knex, auth).whereRaw(`metadata->>'initiative_id' = ?`, [initiativeId]).where('status', 'pending')
  if (exclude.length) pendingQuery = pendingQuery.whereNotIn('id', exclude)
  const pending = (await pendingQuery.select('id', 'payload', 'metadata')) as Row[]
  const blocked: Array<{ actionId: string; reason: string; advisory: string; editable: true }> = []
  for (const row of pending) {
    const payload = parseJson(row.payload)
    const screen = screenReactivationDraft(payload, typeof payload.toName === 'string' ? payload.toName : null)
    if (screen.ok) continue
    await reactivationActions(knex, auth).where('id', row.id).where('status', 'pending').update({
      metadata: knex.raw(`metadata || ?::jsonb`, [JSON.stringify({ fair_housing: { ok: false, blocked: true, advisory: screen.advisory } })]),
      updated_at: now,
    })
    blocked.push({ actionId: String(row.id), reason: FAIR_HOUSING_REASON, advisory: screen.advisory, editable: true })
  }
  const blockedIds = blocked.map((b) => b.actionId)
  let query = reactivationActions(knex, auth).whereRaw(`metadata->>'initiative_id' = ?`, [initiativeId]).where('status', 'pending')
  if (exclude.length) query = query.whereNotIn('id', exclude)
  if (blockedIds.length) query = query.whereNotIn('id', blockedIds)
  const approved = await query.update({
    status: 'approved',
    // Every note approved here passed the screen as it reads now.
    metadata: knex.raw(`metadata || ?::jsonb`, [JSON.stringify({ approval_id: approvalId, approved_at: now.toISOString(), fair_housing: { ok: true } })]),
    updated_at: now,
  })
  if (exclude.length) {
    await reactivationActions(knex, auth).whereRaw(`metadata->>'initiative_id' = ?`, [initiativeId])
      .where('status', 'pending').whereIn('id', exclude).update({ status: 'dismissed', execution_error: 'declined', updated_at: now })
  }
  return { status: 200, json: { ok: true, approved: Number(approved) || 0, blocked } }
}

async function opSendBatch(knex: Knex, em: EntityManager, auth: Auth, body: Row) {
  const initiativeId = body.initiativeId
  if (!isUuid(initiativeId)) return { status: 400, json: { ok: false, error: 'initiativeId (uuid) required' } }
  const cap = clampLimit(body.dailyCap, MAX_DAILY_CAP, MAX_DAILY_CAP)
  const now = new Date()

  // The cap is per organization per UTC day across all reactivation sends,
  // counting in-flight claims whose outcome is not yet known.
  const today = (await reactivationActions(knex, auth)
    .where((q) => q.where((s) => s.where('status', 'sent').where('executed_at', '>=', utcDayStart(now)))
      .orWhere((s) => s.where('status', 'sending').where('updated_at', '>=', utcDayStart(now))))
    .count({ n: '*' }).first()) as Row | undefined
  let slots = slotsLeftToday(cap, Number(today?.n ?? 0))

  let lists: SuppressionLists
  try {
    lists = await loadSuppressions(knex, auth, now)
  } catch (err) {
    console.error('[internal.reactivation] suppression lists unavailable; refusing to send', err)
    return { status: 503, json: { ok: false, error: 'suppression_list_unavailable' } }
  }

  const { sendReply } = await import('@/modules/customers/lib/send-reply')
  const approved = (await reactivationActions(knex, auth).whereRaw(`metadata->>'initiative_id' = ?`, [initiativeId])
    .where('status', 'approved').orderBy('created_at', 'asc').limit(MAX_DAILY_CAP)) as Row[]
  let sent = 0
  const refused: Array<{ actionId: string; contactId: string | null; reason: string }> = []
  const refuse = async (action: Row, contactId: string | null, reason: string) => {
    await knex('inbox_proposal_actions').where('id', action.id).where('status', 'approved')
      .update({ status: 'dismissed', execution_error: reason, updated_at: new Date() })
    refused.push({ actionId: String(action.id), contactId, reason })
  }

  for (const action of approved) {
    if (slots <= 0) break
    const payload = parseJson(action.payload)
    const contactId = typeof payload.contactId === 'string' ? payload.contactId : null
    const contact = contactId
      ? ((await knex('customer_entities').where('id', contactId).where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId).whereNull('deleted_at').first('id', 'display_name', 'primary_email')) as Row | undefined)
      : undefined
    if (!contact) { await refuse(action, contactId, 'contact_missing'); continue }
    const { rows } = await decryptContacts(em, auth, [contact])
    if (!rows.length) { await refuse(action, contactId, 'contact_unreadable'); continue }
    const email = String(rows[0].primary_email || '').trim()
    if (isSuppressed(email, rows[0].stored_email, lists)) { await refuse(action, contactId, 'opted_out'); continue }
    // Fair-housing screen again at send time (defense in depth: a row approved
    // before this screen existed, or changed after drafting, never goes out).
    const meta = parseJson(action.metadata)
    const screen = screenReactivationDraft(payload, rows[0].display_name || (typeof payload.toName === 'string' ? payload.toName : null))
    if (!screen.ok || (meta.fair_housing && (meta.fair_housing as Row).blocked === true)) {
      await refuse(action, contactId, FAIR_HOUSING_REASON)
      continue
    }
    const recent = await knex('email_messages').where('organization_id', auth.orgId).where('contact_id', contactId)
      .where('direction', 'outbound').where('created_at', '>', new Date(now.getTime() - 7 * DAY_MS)).first('id')
    if (recent) { await refuse(action, contactId, 'contacted_recently'); continue }

    const claimed = await knex('inbox_proposal_actions').where('id', action.id).where('status', 'approved')
      .update({ status: 'sending', updated_at: new Date() })
    if (!claimed) continue
    slots -= 1
    let result: { ok: boolean; error?: string; status?: number }
    try {
      result = await sendReply(knex, auth.orgId, auth.tenantId, {
        to: email, toName: rows[0].display_name || null, subject: String(payload.subject || ''), body: String(payload.body || ''),
        contactId, sentByUserId: auth.userId,
      })
    } catch (err) {
      // The provider may or may not have accepted it. Leave the row in 'sending'
      // with a note: it is never picked up again, so it can never go twice.
      console.error('[internal.reactivation] send outcome unknown', { actionId: action.id, error: (err as Error)?.message })
      await knex('inbox_proposal_actions').where('id', action.id).update({ execution_error: 'outcome_unknown', updated_at: new Date() }).catch(() => {})
      continue
    }
    if (result.ok) {
      const done = new Date()
      await knex('inbox_proposal_actions').where('id', action.id)
        .update({ status: 'sent', executed_at: done, executed_by_user_id: auth.userId, execution_error: null, updated_at: done })
      await knex('inbox_proposals').where('id', action.proposal_id).where('organization_id', auth.orgId)
        .update({ status: 'accepted', reviewed_by_user_id: auth.userId, reviewed_at: done, updated_at: done })
      sent += 1
    } else if (result.status === 400) {
      // No sending mailbox connected: nothing went out. Put it back and stop;
      // every other draft would fail the same way.
      await knex('inbox_proposal_actions').where('id', action.id).where('status', 'sending')
        .update({ status: 'approved', updated_at: new Date() })
      const remaining = await countApproved(knex, auth, initiativeId)
      return { status: 200, json: { ok: false, error: 'no_sending_mailbox', sent, remaining, refused } }
    } else {
      await knex('inbox_proposal_actions').where('id', action.id)
        .update({ status: 'failed', execution_error: (result.error || 'send_failed').slice(0, 300), updated_at: new Date() })
      refused.push({ actionId: String(action.id), contactId, reason: 'send_failed' })
    }
  }
  return { status: 200, json: { ok: true, sent, remaining: await countApproved(knex, auth, initiativeId), refused } }
}

async function countApproved(knex: Knex, auth: Auth, initiativeId: string): Promise<number> {
  const row = (await reactivationActions(knex, auth).whereRaw(`metadata->>'initiative_id' = ?`, [initiativeId])
    .where('status', 'approved').count({ n: '*' }).first()) as Row | undefined
  return Number(row?.n ?? 0)
}

export async function POST(req: Request) {
  if (unauthorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as Row
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  const op = typeof body.op === 'string' ? body.op : ''
  if (!noliUserId || !['candidates', 'draft', 'approve', 'send-batch'].includes(op)) {
    return NextResponse.json({ ok: false, error: 'noliUserId and op (candidates | draft | approve | send-batch) required' }, { status: 400 })
  }
  try {
    const auth = await resolveAuth(noliUserId)
    if (!auth) return NextResponse.json({ ok: false, error: 'no CRM account for this user' }, { status: 404 })
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex() as unknown as Knex
    if (op === 'candidates') return NextResponse.json(await opCandidates(knex, em, auth))
    const result = op === 'draft'
      ? await opDraft(knex, em, auth, noliUserId, body)
      : op === 'approve'
        ? await opApprove(knex, auth, body)
        : await opSendBatch(knex, em, auth, body)
    return NextResponse.json(result.json, { status: result.status })
  } catch (err) {
    console.error('[internal.reactivation]', op, (err as Error)?.message)
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 })
  }
}
