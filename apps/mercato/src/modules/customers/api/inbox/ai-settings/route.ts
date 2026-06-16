export const metadata = { path: '/inbox/ai-settings', GET: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

// Reply-mode model for the personal Inbox AI desk. Mirrors the Customer Service
// settings shape so a later drafting phase can share the logic. This file is the
// SETTINGS + STORAGE phase only: nothing here drafts, auto-sends, or enforces a
// flag scenario yet.
type ReplyMode = 'draft' | 'auto' | 'hybrid'
type FlagAction = 'pause' | 'auto_send'
export type FlagScenario = { key: string; label: string; enabled: boolean; action: FlagAction; instructions: string }

const VALID_MODES = new Set<ReplyMode>(['draft', 'auto', 'hybrid'])
const VALID_FLAG_ACTIONS = new Set<FlagAction>(['pause', 'auto_send'])
const MAX_FLAG_INSTRUCTIONS_CHARS = 4000
const CUSTOM_KEY_PREFIX = 'custom_'
const DEFAULT_THRESHOLD = 0.85

// Default flag-scenario seed, tailored to a personal inbox. Returned by GET when
// the org has saved none, so the Inbox Settings tab always renders the full list.
// All default to disabled + pause + no instructions; the user opts in and tailors
// each one. `key` is the stable identifier; `label` is shown to the user.
export const DEFAULT_FLAG_SCENARIOS: FlagScenario[] = [
  { key: 'angry_or_upset', label: 'Upset or angry sender', enabled: false, action: 'pause', instructions: '' },
  { key: 'incoherent', label: 'Incoherent or unclear message', enabled: false, action: 'pause', instructions: '' },
  { key: 'sensitive', label: 'Sensitive or personal matter', enabled: false, action: 'pause', instructions: '' },
  { key: 'money', label: 'Money, invoices, or payments', enabled: false, action: 'pause', instructions: '' },
  { key: 'complaint', label: 'Complaint or negative feedback', enabled: false, action: 'pause', instructions: '' },
  { key: 'legal', label: 'Legal or compliance matter', enabled: false, action: 'pause', instructions: '' },
]

const CANONICAL_KEYS = new Set(DEFAULT_FLAG_SCENARIOS.map((s) => s.key))

function isCustomKey(key: unknown): key is string {
  return typeof key === 'string' && key.startsWith(CUSTOM_KEY_PREFIX) && key.length > CUSTOM_KEY_PREFIX.length && !CANONICAL_KEYS.has(key)
}

// Validate + normalize a single incoming custom-scenario entry. Returns null
// when the entry is not a usable custom scenario (so the caller can skip it).
function normalizeCustomScenario(u: any): FlagScenario | null {
  if (!u || typeof u !== 'object') return null
  if (!isCustomKey(u.key)) return null
  const label = typeof u.label === 'string' ? u.label.trim().slice(0, 200) : ''
  if (!label) return null
  const action = VALID_FLAG_ACTIONS.has(u.action) ? u.action : 'pause'
  return {
    key: u.key,
    label,
    enabled: u.enabled === true,
    action: action as FlagAction,
    instructions: typeof u.instructions === 'string' ? u.instructions.slice(0, MAX_FLAG_INSTRUCTIONS_CHARS) : '',
  }
}

// Normalize a stored/incoming flag_scenarios value into a clean FlagScenario[].
// jsonb may arrive parsed or as a string. The canonical 6 keep their fixed
// labels/order; we overlay the user's enabled/action/instructions onto each. Any
// valid CUSTOM entries (custom_ prefix + non-empty label) pass through and are
// appended AFTER the canonical set. Unknown non-custom keys are dropped. Returns
// null when nothing usable is present (so the caller can seed defaults).
function parseFlagScenarios(raw: any): FlagScenario[] | null {
  let arr: any = raw
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr) } catch { return null }
  }
  if (!Array.isArray(arr)) return null
  const byKey = new Map<string, any>()
  for (const item of arr) {
    if (item && typeof item === 'object' && typeof item.key === 'string') byKey.set(item.key, item)
  }
  const canonical = DEFAULT_FLAG_SCENARIOS.map((def) => {
    const u = byKey.get(def.key)
    if (!u) return { ...def }
    const action = VALID_FLAG_ACTIONS.has(u.action) ? u.action : 'pause'
    return {
      key: def.key,
      label: def.label,
      enabled: u.enabled === true,
      action: action as FlagAction,
      instructions: typeof u.instructions === 'string' ? u.instructions.slice(0, MAX_FLAG_INSTRUCTIONS_CHARS) : '',
    }
  })
  const customs: FlagScenario[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    const c = normalizeCustomScenario(item)
    if (c && !seen.has(c.key)) { seen.add(c.key); customs.push(c) }
  }
  return [...canonical, ...customs]
}

function normalizeThreshold(v: unknown, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

// Shape the stored row for the client. Always returns a full flag-scenario list
// so the Inbox Settings tab can render it (seeded defaults when none saved).
function serialize(row: any) {
  if (!row) return null
  return {
    ...row,
    reply_mode: VALID_MODES.has(row.reply_mode) ? row.reply_mode : 'draft',
    hybrid_confidence_threshold: row.hybrid_confidence_threshold != null ? Number(row.hybrid_confidence_threshold) : DEFAULT_THRESHOLD,
    flag_scenarios: parseFlagScenarios(row.flag_scenarios) || DEFAULT_FLAG_SCENARIOS.map((s) => ({ ...s })),
  }
}

// GET: Load AI draft settings for this org. When no row exists yet, the client
// falls back to its own defaults; the flag-scenario seed is also surfaced
// separately so a fresh org still renders the full list.
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const settings = await knex('inbox_ai_settings').where('organization_id', auth.orgId).first()
    return NextResponse.json({
      ok: true,
      data: serialize(settings),
      // Default scenario seed so the UI shows the list even before a row exists.
      defaultFlagScenarios: DEFAULT_FLAG_SCENARIOS.map((s) => ({ ...s })),
    })
  } catch (error) {
    console.error('[inbox.ai-settings.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// PUT: Save AI draft settings. Merges with the existing row (each field uses
// `?? existing`), so callers may send any subset of fields safely.
export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()

    const existing = await knex('inbox_ai_settings').where('organization_id', auth.orgId).first()

    // reply_mode: one of draft | auto | hybrid. Reject anything else (keep the
    // existing value rather than silently corrupting it).
    const replyModeIn = typeof body.replyMode === 'string' ? body.replyMode : undefined
    const replyMode = (replyModeIn && VALID_MODES.has(replyModeIn as ReplyMode))
      ? replyModeIn
      : (existing?.reply_mode || 'draft')

    const existingThreshold = existing?.hybrid_confidence_threshold != null
      ? Number(existing.hybrid_confidence_threshold)
      : DEFAULT_THRESHOLD
    const hybridConfidenceThreshold = body.hybridConfidenceThreshold !== undefined
      ? normalizeThreshold(body.hybridConfidenceThreshold, existingThreshold)
      : existingThreshold

    // flag_scenarios: clamp/validate the client list onto the canonical default
    // keys/labels. Omitted in the body = keep existing. parseFlagScenarios always
    // returns the full canonical set, so we store a complete, trusted array.
    let flagScenarios: FlagScenario[]
    if (body.flagScenarios !== undefined) {
      flagScenarios = parseFlagScenarios(body.flagScenarios) || DEFAULT_FLAG_SCENARIOS.map((s) => ({ ...s }))
    } else {
      flagScenarios = parseFlagScenarios(existing?.flag_scenarios) || DEFAULT_FLAG_SCENARIOS.map((s) => ({ ...s }))
    }

    const fields = {
      enabled: body.enabled ?? existing?.enabled ?? false,
      knowledge_base: body.knowledgeBase ?? existing?.knowledge_base ?? '',
      tone: body.tone ?? existing?.tone ?? 'professional',
      instructions: body.instructions ?? existing?.instructions ?? '',
      business_name: body.businessName ?? existing?.business_name ?? '',
      business_description: body.businessDescription ?? existing?.business_description ?? '',
      signature: body.signature ?? existing?.signature ?? '',
      reply_mode: replyMode,
      hybrid_confidence_threshold: hybridConfidenceThreshold,
      flag_scenarios: JSON.stringify(flagScenarios),
      updated_at: new Date(),
    }

    if (existing) {
      await knex('inbox_ai_settings').where('id', existing.id).update(fields)
    } else {
      await knex('inbox_ai_settings').insert({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        ...fields,
        created_at: new Date(),
      })
    }

    const updated = await knex('inbox_ai_settings').where('organization_id', auth.orgId).first()
    return NextResponse.json({ ok: true, data: serialize(updated) })
  } catch (error) {
    console.error('[inbox.ai-settings.save]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
