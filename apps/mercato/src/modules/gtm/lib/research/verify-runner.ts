import { GtmAuditEvent, GtmCandidate, GtmCandidateMatch, GtmPlay } from '../../data/entities'
import type { GtmAiMeter, GtmDraftModel } from '../ai/model'
import {
  buildCriteriaRequest,
  ensureOwnershipCriterion,
  parseCriteria,
  verifyProspect,
  VERIFY_VERSION,
  type Criterion,
} from './verify'
import { readSite as defaultReadSite, type SiteRead } from './site-fetch'
import { nextToVerify, type ShortlistEm } from './shortlist'

/*
 * The candidates 'verify' op (Launch Pad shortlist check, verify.ts): checks
 * the next best unverified viable rows of the given runs on their own
 * websites against the member's criteria, records the verification on each
 * match, and removes a row that fails the member's own hard criteria
 * (rejected, reason 'site_check_excluded', evidence in qualification). No
 * provider spend: page reads plus one small model call per row, metered to
 * the customer's AI allowance like the lead check.
 */

export const VERIFY_BATCH_MAX = 25
export const VERIFY_CONCURRENCY = 5
export const VERIFY_FEATURE = 'gtm-site-check'
export const SITE_CHECK_EXCLUDED = 'site_check_excluded'

export type VerifyEm = ShortlistEm & {
  persist(entity: object): unknown
  create<T extends object>(entity: new () => T, data: object): T
  flush(): Promise<void>
}

export type VerifyOpResult = {
  criteria: Criterion[]
  checked: number
  excluded: number
  failed: number
}

function meteredModel(model: GtmDraftModel, meter: GtmAiMeter | undefined): GtmDraftModel {
  if (!meter) return model
  return {
    ...model,
    async generate(request) {
      const started = Date.now()
      try {
        const out = await model.generate(request)
        await meter({ model: out.model, tokensIn: out.tokensIn, tokensOut: out.tokensOut, tokenUsageKnown: out.tokenUsageKnown !== false, feature: VERIFY_FEATURE, status: 'succeeded', latencyMs: Date.now() - started, retryCount: 0 })
        return out
      } catch (error) {
        await meter({ model: model.modelId ?? 'unknown', tokensIn: 0, tokensOut: 0, tokenUsageKnown: false, feature: VERIFY_FEATURE, status: 'failed', latencyMs: Date.now() - started, retryCount: 0, failureCode: 'model_call_failed' })
        throw error
      }
    },
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()) : []
}

export async function runVerifyOp(input: {
  em: VerifyEm
  ctx: { organizationId: string; tenantId: string }
  runIds: string[]
  limit: number
  icp: string
  criteria?: Criterion[] | null
  model: GtmDraftModel
  meter?: GtmAiMeter
  readSite?: (website: string | null) => Promise<SiteRead>
  now?: () => Date
}): Promise<VerifyOpResult> {
  const { em, ctx } = input
  const model = meteredModel(input.model, input.meter)
  const matchIds = await nextToVerify(em, ctx, { runIds: input.runIds, limit: Math.min(VERIFY_BATCH_MAX, Math.max(1, input.limit)) })
  const matches = matchIds.length
    ? await em.find(GtmCandidateMatch, { ...ctx, id: { $in: matchIds }, deletedAt: null }) as GtmCandidateMatch[]
    : []
  const playIds = [...new Set(matches.map((m) => m.playId))]
  const plays = playIds.length ? await em.find(GtmPlay, { ...ctx, id: { $in: playIds } }) as GtmPlay[] : []
  const exclusions = [...new Set(plays.flatMap((p) => {
    const q = (p.providerQuery ?? {}) as Record<string, unknown>
    return [...strings(q.exclude_company_keywords), ...strings(q.exclude_industries), ...strings(q.negative_terms)]
  }))].slice(0, 30)
  const audience = plays.map((p) => p.audience).find((a): a is string => typeof a === 'string' && a.trim().length > 0) ?? null

  let criteria = (input.criteria ?? []).filter((c) => c && typeof c.text === 'string' && c.text.trim()).slice(0, 6)
  if (criteria.length === 0) {
    try {
      const generated = await model.generate(buildCriteriaRequest({ icp: input.icp, exclusions, audience }))
      criteria = parseCriteria(generated.text)
    } catch {
      criteria = []
    }
  }
  criteria = ensureOwnershipCriterion(criteria, input.icp, exclusions)
  const result: VerifyOpResult = { criteria, checked: 0, excluded: 0, failed: 0 }
  if (matches.length === 0) return result
  if (criteria.length === 0) {
    // Nothing to check against: do not mark rows verified on no criteria.
    result.failed = matches.length
    return result
  }

  const candidates = await em.find(GtmCandidate, { ...ctx, id: { $in: [...new Set(matches.map((m) => m.candidateId))] }, deletedAt: null }) as GtmCandidate[]
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const queue = [...matches]
  const readSite = input.readSite ?? ((website: string | null) => defaultReadSite(website))
  await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, async () => {
    for (let match = queue.shift(); match; match = queue.shift()) {
      const candidate = byId.get(match.candidateId)
      if (!candidate) continue
      const identity = (candidate.identity ?? {}) as Record<string, unknown>
      const text = (key: string) => (typeof identity[key] === 'string' && (identity[key] as string).trim() ? (identity[key] as string).trim() : null)
      try {
        const { verification } = await verifyProspect({
          criteria,
          audience,
          business: {
            name: text('name') ?? '',
            category: text('industry'),
            location: text('location'),
            website: text('website') ?? text('domain'),
            phone: text('phone'),
          },
          model,
          readSite,
          now: input.now,
        })
        // A row whose model answer was lost twice is recorded as checked with
        // every criterion unknown (a low grade, never an earned label), so one
        // unreadable page cannot hold a member's delivery back forever.
        const prior = ((match.qualification ?? {}) as Record<string, unknown>).verification as { attempts?: number } | undefined
        const attempts = (prior?.attempts ?? 0) + 1
        if (!verification.complete && attempts >= 2) verification.complete = true
        const qualification = { ...((match.qualification ?? {}) as Record<string, unknown>), verification: { ...verification, attempts } }
        match.qualification = qualification
        if (verification.excluded) {
          match.fitStatus = 'rejected'
          match.rejectReason = SITE_CHECK_EXCLUDED
          result.excluded += 1
        }
        if (verification.complete) result.checked += 1
        else result.failed += 1
        em.persist(match)
      } catch {
        result.failed += 1
      }
    }
  }))
  if (result.checked > 0 || result.excluded > 0) {
    em.persist(em.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'system',
      action: 'gtm.candidates.site_check',
      objectType: 'gtm_research_run',
      objectId: input.runIds[0],
      metadata: { version: VERIFY_VERSION, checked: result.checked, excluded: result.excluded, failed: result.failed, runs: input.runIds.length },
    }))
  }
  await em.flush()
  return result
}

export type VerifyOutcome =
  | ({ status: 'checked' } & VerifyOpResult)
  | { status: 'skipped'; reason: 'allowance' | 'ai_unconfigured' | 'error' }

/** The op as the route runs it: allowance gate (fail closed), the customer's
 *  metered model, then runVerifyOp. Never throws. */
export async function runVerifyForCustomer(input: {
  em: unknown
  ctx: { organizationId: string; tenantId: string }
  noliUserId: string
  requestId?: string | null
  runIds: string[]
  limit: number
  icp: string
  criteria?: Criterion[] | null
}): Promise<VerifyOutcome> {
  try {
    const { checkCustomersAiAllowance } = await import('../../../../lib/usage/allowance')
    const { meterCustomersAiStrict } = await import('../../../../lib/usage/meter')
    const gate = await checkCustomersAiAllowance({ orgId: input.ctx.organizationId }, 'google', { failureMode: 'closed' })
    if (!gate.allowed) return { status: 'skipped', reason: 'allowance' }
    const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) return { status: 'skipped', reason: 'ai_unconfigured' }
    const { createGeminiDraftModel } = await import('../ai/model')
    const { createGtmTelemetryMeter } = await import('../ai/telemetry')
    const meter = createGtmTelemetryMeter({
      em: input.em as never,
      ctx: { ...input.ctx, userId: input.noliUserId, requestId: input.requestId ?? null },
      surface: 'site_check',
      operationKey: `gtm:site-check:${input.runIds[0]}:${Date.now()}`,
      canonicalMeter: async (usage, invocationKey) => {
        await meterCustomersAiStrict({ orgId: input.ctx.organizationId }, {
          noliUserId: input.noliUserId,
          model: usage.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          feature: usage.feature,
          byoKey: !!gate.byoApiKey,
          idempotencyKey: invocationKey,
          metadata: { status: usage.status === 'failed' ? 'failed' : 'completed', attempt: 1, token_usage_known: usage.tokenUsageKnown !== false, failure_code: usage.failureCode ?? null, retry_count: usage.retryCount ?? 0 },
        })
      },
    })
    const result = await runVerifyOp({
      em: input.em as VerifyEm,
      ctx: input.ctx,
      runIds: input.runIds,
      limit: input.limit,
      icp: input.icp,
      criteria: input.criteria,
      model: createGeminiDraftModel(apiKey),
      meter,
    })
    return { status: 'checked', ...result }
  } catch (error) {
    console.error('[gtm.site-check] skipped after an error', error instanceof Error ? error.message : error)
    return { status: 'skipped', reason: 'error' }
  }
}
