// ORM-SKIP: raw upsert into customer_service_settings (single row per org)
export const metadata = {
  path: '/customer-service/settings',
  GET: { requireAuth: true, requireFeatures: ['email.view'] },
  PUT: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { buildDefaultSignature } from '@/modules/customers/lib/draft-reply'

const VALID_MODES = new Set(['draft', 'auto', 'hybrid'])

function normalizeThreshold(v: unknown, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

// jsonb can come back from pg as a parsed object or (depending on driver/path) a
// string. Coerce to a plain object map keyed by connection id.
function parseSourceModes(raw: any): Record<string, { mode: string; threshold: number }> {
  let obj: any = raw
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return {} }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out: Record<string, { mode: string; threshold: number }> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object') continue
    const mode = (v as any).mode
    if (!VALID_MODES.has(mode)) continue
    out[k] = { mode, threshold: normalizeThreshold((v as any).threshold, 0.8) }
  }
  return out
}

// Build the stored source_modes map from client input, keeping only entries for
// connections that are actually in the watched list and with valid mode/threshold.
function normalizeSourceModesInput(input: any, watched: string[] | null): Record<string, { mode: string; threshold: number }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  // watched === null means "watch all"; we can't constrain to ids, so accept any.
  const allowed = watched && watched.length > 0 ? new Set(watched) : null
  const out: Record<string, { mode: string; threshold: number }> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== 'string' || !k) continue
    if (allowed && !allowed.has(k)) continue
    if (!v || typeof v !== 'object') continue
    const mode = (v as any).mode
    if (!VALID_MODES.has(mode)) continue
    out[k] = { mode, threshold: normalizeThreshold((v as any).threshold, 0.8) }
  }
  return out
}

function serialize(row: any, defaultSignature = '') {
  if (!row) {
    return { enabled: false, watchedConnectionIds: null, replyMode: 'draft', hybridConfidenceThreshold: 0.8, sourceModes: {}, signature: null, defaultSignature }
  }
  return {
    id: row.id,
    enabled: !!row.enabled,
    watchedConnectionIds: row.watched_connection_ids ?? null,
    replyMode: row.reply_mode || 'draft',
    hybridConfidenceThreshold: row.hybrid_confidence_threshold != null ? Number(row.hybrid_confidence_threshold) : 0.8,
    sourceModes: parseSourceModes(row.source_modes),
    signature: row.signature ?? null,
    // Computed sign-off the UI uses to prepopulate the field when no signature
    // is saved yet. Built from the org's business name; never client-supplied.
    defaultSignature,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// GET: load the org's customer service config (returns defaults if no row yet)
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const row = await knex('customer_service_settings').where('organization_id', auth.orgId).first()
    // Resolve the org's business name (same source brand voice uses) to build a
    // default sign-off the UI can prepopulate when no signature is saved.
    const bpRow = await knex('business_profiles').where('organization_id', auth.orgId).select('business_name').first()
    const defaultSignature = buildDefaultSignature(bpRow?.business_name)
    return NextResponse.json({ ok: true, data: serialize(row, defaultSignature) })
  } catch (error) {
    console.error('[customer-service.settings.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load settings' }, { status: 500 })
  }
}

// PUT: upsert the single org row. Self-scoped by auth.orgId; client org is ignored.
export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json().catch(() => ({}))

    const existing = await knex('customer_service_settings').where('organization_id', auth.orgId).first()

    // Normalize watchedConnectionIds to a string[] or null (null = all active).
    let watched: string[] | null = existing?.watched_connection_ids ?? null
    if (body.watchedConnectionIds !== undefined) {
      if (Array.isArray(body.watchedConnectionIds)) {
        const cleaned = body.watchedConnectionIds.filter((v: unknown) => typeof v === 'string' && v.length > 0)
        watched = cleaned.length > 0 ? cleaned : null
      } else {
        watched = null
      }
    }

    // reply_mode: one of draft | auto | hybrid. Reject anything else (keep the
    // existing value rather than silently corrupting it).
    const replyModeIn = typeof body.replyMode === 'string' ? body.replyMode : undefined
    const replyMode = (replyModeIn && VALID_MODES.has(replyModeIn))
      ? replyModeIn
      : (existing?.reply_mode || 'draft')

    const existingThreshold = existing?.hybrid_confidence_threshold != null
      ? Number(existing.hybrid_confidence_threshold)
      : 0.8
    const hybridConfidenceThreshold = body.hybridConfidenceThreshold !== undefined
      ? normalizeThreshold(body.hybridConfidenceThreshold, existingThreshold)
      : existingThreshold

    // source_modes: per-mailbox overrides keyed by connection id. Only keep
    // entries for connections in the (resolved) watched list and with a valid
    // mode/threshold. Omitted in the body = keep existing.
    let sourceModes: Record<string, { mode: string; threshold: number }>
    if (body.sourceModes !== undefined) {
      sourceModes = normalizeSourceModesInput(body.sourceModes, watched)
    } else {
      sourceModes = parseSourceModes(existing?.source_modes)
      // Drop overrides for any connection no longer watched.
      if (watched && watched.length > 0) {
        const allowed = new Set(watched)
        sourceModes = Object.fromEntries(Object.entries(sourceModes).filter(([k]) => allowed.has(k)))
      }
    }

    // Auto-derive `enabled` instead of trusting a client toggle. The feature is
    // active whenever at least one mailbox is being watched. watched === null
    // means "watch all connected support inboxes", which also counts as active.
    // We only flip enabled to false when there are explicitly zero watched ids.
    // (If the client still sends a boolean, we ignore it on purpose.)
    const hasWatched = watched === null || (Array.isArray(watched) && watched.length > 0)
    const enabled = hasWatched ? true : false

    const fields = {
      enabled,
      watched_connection_ids: watched ? JSON.stringify(watched) : null,
      reply_mode: replyMode,
      hybrid_confidence_threshold: hybridConfidenceThreshold,
      source_modes: Object.keys(sourceModes).length > 0 ? JSON.stringify(sourceModes) : null,
      signature: body.signature !== undefined ? (body.signature || null) : (existing?.signature ?? null),
      updated_at: new Date(),
    }

    if (existing) {
      await knex('customer_service_settings').where('id', existing.id).update(fields)
    } else {
      await knex('customer_service_settings').insert({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        ...fields,
        created_at: new Date(),
      })
    }

    const updated = await knex('customer_service_settings').where('organization_id', auth.orgId).first()
    return NextResponse.json({ ok: true, data: serialize(updated) })
  } catch (error) {
    console.error('[customer-service.settings.put]', error)
    return NextResponse.json({ ok: false, error: 'Failed to save settings' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Customer Service settings',
  methods: {
    GET: { summary: 'Get customer service settings for the current org', tags: ['Customer Service'] },
    PUT: { summary: 'Update customer service settings for the current org', tags: ['Customer Service'] },
  },
}
