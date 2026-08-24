import crypto from 'crypto'
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import type { SourceAdapter } from '../adapters/types'
import type { GtmCreditLedger } from '../credits/ledger'
import {
  GtmAuditEvent,
  GtmAutoRefillCycle,
  GtmAutoRefillPolicy,
  GtmCampaign,
  GtmCampaignVersion,
  GtmPlay,
  GtmProviderOperation,
  GtmResearchRun,
} from '../../data/entities'
import { approvalEnvelopeMatches } from '../campaign/approve'
import { buildSourcePlan } from '../research/plan'
import {
  executeResearchRun,
  type ResearchRunExecutionResult,
} from '../research/execute'
import type { AutoRefillEm } from './policy'
import {
  AUTO_REFILL_CYCLE_SCHEMA_VERSION,
  buildAutoRefillPolicyHash,
  localDateInTimeZone,
  parseApprovedAutoRefillConfig,
} from './contract'

export type ProcessAutoRefillCycleInput = {
  organizationId: string
  tenantId: string
  policyId: string
  noliOrganizationId: string
  representedNoliUserId: string
}

export type AutoRefillCycleOutcome =
  | { outcome: 'inactive'; cycle: null; researchRun: null }
  | { outcome: 'already_processed'; cycle: GtmAutoRefillCycle; researchRun: GtmResearchRun | null }
  | { outcome: 'blocked'; cycle: GtmAutoRefillCycle; researchRun: null }
  | {
      outcome: 'completed' | 'failed' | 'reconciliation_required'
      cycle: GtmAutoRefillCycle
      researchRun: GtmResearchRun
    }

function runInputSnapshot(play: GtmPlay, plan: ReturnType<typeof buildSourcePlan> & { ok: true }) {
  return {
    play: {
      id: play.id,
      signal: play.signal ?? null,
      entity_unit: play.entityUnit ?? null,
      geography: play.geography ?? null,
      market_type: play.marketType ?? null,
      audience: play.audience ?? null,
      provider_query: play.providerQuery ?? null,
      recency_window: play.recencyWindow ?? null,
      execution_eligibility: play.executionEligibility,
    },
    requested_limits: plan.limits,
    query: plan.query,
    trigger: 'auto_refill',
  }
}

function runProviderPlan(plan: ReturnType<typeof buildSourcePlan> & { ok: true }) {
  return {
    schemaVersion: plan.schemaVersion,
    planHash: plan.planHash,
    adapterPlan: plan.adapterPlan,
    plannedRawCapacity: plan.plannedRawCapacity,
    unsupportedDimensions: plan.unsupportedDimensions,
    qualificationProfile: plan.qualificationProfile,
    query: plan.query,
    trigger: 'auto_refill',
  }
}

async function existingCycle(
  em: AutoRefillEm,
  policy: GtmAutoRefillPolicy,
  localDate: string,
): Promise<GtmAutoRefillCycle | null> {
  return em.findOne(GtmAutoRefillCycle, {
    policyId: policy.id,
    organizationId: policy.organizationId,
    tenantId: policy.tenantId,
    localDate,
    deletedAt: null,
  })
}

async function blockCycle(
  em: AutoRefillEm,
  policy: GtmAutoRefillPolicy,
  localDate: string,
  failureCode: string,
  now: Date,
): Promise<GtmAutoRefillCycle> {
  const found = await existingCycle(em, policy, localDate)
  if (found) return found
  try {
    return await em.transactional(async (tem) => {
      const locked = await tem.findOne(GtmAutoRefillPolicy, {
        id: policy.id,
        organizationId: policy.organizationId,
        tenantId: policy.tenantId,
        deletedAt: null,
      }, { lockMode: LockMode.PESSIMISTIC_WRITE })
      if (!locked) throw new Error('auto-refill policy disappeared')
      const prior = await tem.findOne(GtmAutoRefillCycle, {
        policyId: locked.id,
        organizationId: locked.organizationId,
        tenantId: locked.tenantId,
        localDate,
        deletedAt: null,
      })
      if (prior) return prior
      const cycle = tem.create(GtmAutoRefillCycle, {
        id: crypto.randomUUID(),
        organizationId: locked.organizationId,
        tenantId: locked.tenantId,
        policyId: locked.id,
        campaignId: locked.campaignId,
        campaignVersionId: locked.campaignVersionId,
        playId: locked.playId,
        researchRunId: null,
        localDate,
        policyHash: locked.policyHash,
        campaignContentHash: locked.campaignContentHash,
        planHash: locked.planHash,
        status: 'blocked',
        failureCode,
        result: { schema_version: AUTO_REFILL_CYCLE_SCHEMA_VERSION, provider_calls: 0 },
        startedAt: null,
        completedAt: now,
      })
      locked.status = 'blocked'
      locked.blockedReason = failureCode
      locked.fence += 1
      locked.lastCycleLocalDate = localDate
      locked.lastCycleAt = now
      tem.persist(cycle)
      tem.persist(locked)
      tem.persist(tem.create(GtmAuditEvent, {
        organizationId: locked.organizationId,
        tenantId: locked.tenantId,
        actor: 'system',
        actorUserId: null,
        action: 'gtm.auto_refill.blocked',
        objectType: 'gtm_auto_refill_cycle',
        objectId: cycle.id,
        requestId: null,
        metadata: {
          policy_id: locked.id,
          campaign_id: locked.campaignId,
          local_date: localDate,
          failure_code: failureCode,
          provider_calls: 0,
        },
      }))
      await tem.flush()
      return cycle
    })
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
    const winner = await existingCycle(em, policy, localDate)
    if (!winner) throw error
    return winner
  }
}

function countOnlyResult(result: ResearchRunExecutionResult): Record<string, unknown> {
  return {
    schema_version: AUTO_REFILL_CYCLE_SCHEMA_VERSION,
    research_status: result.status,
    reconciled_credits: result.reconciledCredits,
    candidates_inserted: result.candidatesInserted,
    candidate_matches_created: result.candidateMatchesCreated,
    candidates_reused: result.candidatesReused,
    duplicates_skipped: result.duplicatesSkipped,
    reconciliation_required: result.reconciliationRequired,
    funnel: {
      target_accepted: result.funnel.targetAccepted,
      max_raw_candidates: result.funnel.maxRawCandidates,
      raw_candidates_found: result.funnel.rawCandidatesFound,
      accepted: result.funnel.accepted,
      review: result.funnel.review,
      rejected: result.funnel.rejected,
      target_met: result.funnel.targetMet,
      stop_reason: result.funnel.stopReason,
    },
  }
}

async function finishCycle(
  em: AutoRefillEm,
  policyId: string,
  cycleId: string,
  run: GtmResearchRun,
  result: ResearchRunExecutionResult,
  now: Date,
): Promise<GtmAutoRefillCycle> {
  return em.transactional(async (tem) => {
    const policy = await tem.findOne(GtmAutoRefillPolicy, {
      id: policyId,
      organizationId: run.organizationId,
      tenantId: run.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    const cycle = await tem.findOne(GtmAutoRefillCycle, {
      id: cycleId,
      policyId,
      organizationId: run.organizationId,
      tenantId: run.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!policy || !cycle) throw new Error('auto-refill cycle state disappeared')
    const status = result.reconciliationRequired
      ? 'reconciliation_required'
      : result.status === 'completed' ? 'completed' : 'failed'
    cycle.status = status
    cycle.failureCode = status === 'completed' ? null : status
    cycle.result = countOnlyResult(result)
    cycle.completedAt = now
    if (status === 'completed') {
      policy.lastSuccessAt = now
    } else {
      policy.status = 'blocked'
      policy.blockedReason = status
      policy.fence += 1
    }
    tem.persist(cycle)
    tem.persist(policy)
    tem.persist(tem.create(GtmAuditEvent, {
      organizationId: run.organizationId,
      tenantId: run.tenantId,
      actor: 'system',
      actorUserId: null,
      action: 'gtm.auto_refill.cycle_completed',
      objectType: 'gtm_auto_refill_cycle',
      objectId: cycle.id,
      requestId: null,
      metadata: {
        policy_id: policy.id,
        campaign_id: policy.campaignId,
        research_run_id: run.id,
        local_date: cycle.localDate,
        status,
        reconciled_credits: result.reconciledCredits,
        accepted: result.funnel.accepted,
        review: result.funnel.review,
        rejected: result.funnel.rejected,
        target_met: result.funnel.targetMet,
      },
    }))
    await tem.flush()
    return cycle
  })
}

async function failCycleAfterException(
  em: AutoRefillEm,
  policy: GtmAutoRefillPolicy,
  cycle: GtmAutoRefillCycle,
  run: GtmResearchRun,
  now: Date,
): Promise<GtmAutoRefillCycle> {
  const operations = await em.find(GtmProviderOperation, {
    organizationId: policy.organizationId,
    tenantId: policy.tenantId,
    researchRunId: run.id,
  })
  const unresolved = operations.some((operation) =>
    operation.localStatusMirror === 'provider_started'
    || operation.localStatusMirror === 'reconciliation_required')
  return em.transactional(async (tem) => {
    const currentPolicy = await tem.findOne(GtmAutoRefillPolicy, {
      id: policy.id,
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    const currentCycle = await tem.findOne(GtmAutoRefillCycle, {
      id: cycle.id,
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    const currentRun = await tem.findOne(GtmResearchRun, {
      id: run.id,
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!currentPolicy || !currentCycle || !currentRun) {
      throw new Error('auto-refill failure state disappeared')
    }
    const status = unresolved ? 'reconciliation_required' : 'failed'
    currentCycle.status = status
    currentCycle.failureCode = 'execution_exception'
    currentCycle.result = {
      schema_version: AUTO_REFILL_CYCLE_SCHEMA_VERSION,
      research_status: 'failed',
      reconciliation_required: unresolved,
      provider_operation_count: operations.length,
    }
    currentCycle.completedAt = now
    currentRun.status = 'failed'
    currentRun.completedAt = now
    currentPolicy.status = 'blocked'
    currentPolicy.blockedReason = status
    currentPolicy.fence += 1
    tem.persist(currentCycle)
    tem.persist(currentRun)
    tem.persist(currentPolicy)
    tem.persist(tem.create(GtmAuditEvent, {
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      actor: 'system',
      actorUserId: null,
      action: 'gtm.auto_refill.cycle_failed',
      objectType: 'gtm_auto_refill_cycle',
      objectId: currentCycle.id,
      requestId: null,
      metadata: {
        policy_id: currentPolicy.id,
        research_run_id: currentRun.id,
        local_date: currentCycle.localDate,
        status,
        failure_code: 'execution_exception',
        provider_operation_count: operations.length,
      },
    }))
    await tem.flush()
    return currentCycle
  })
}

export async function processAutoRefillCycle(
  em: AutoRefillEm,
  input: ProcessAutoRefillCycleInput,
  deps: {
    adapters: Record<string, SourceAdapter>
    ledger: GtmCreditLedger
    now?: () => Date
  },
): Promise<AutoRefillCycleOutcome> {
  const now = deps.now?.() ?? new Date()
  const policy = await em.findOne(GtmAutoRefillPolicy, {
    id: input.policyId,
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    deletedAt: null,
  })
  if (!policy || policy.status !== 'active') {
    return { outcome: 'inactive', cycle: null, researchRun: null }
  }
  if (
    policy.noliOrganizationId !== input.noliOrganizationId
    || policy.representedNoliUserId !== input.representedNoliUserId
  ) {
    const localDate = localDateInTimeZone(now, policy.timezone)
    const cycle = await blockCycle(em, policy, localDate, 'identity_changed', now)
    return { outcome: 'blocked', cycle, researchRun: null }
  }
  const localDate = localDateInTimeZone(now, policy.timezone)
  const prior = await existingCycle(em, policy, localDate)
  if (prior) {
    const researchRun = prior.researchRunId
      ? await em.findOne(GtmResearchRun, {
          id: prior.researchRunId,
          organizationId: policy.organizationId,
          tenantId: policy.tenantId,
          deletedAt: null,
        })
      : null
    return { outcome: 'already_processed', cycle: prior, researchRun }
  }

  const [campaign, version, play] = await Promise.all([
    em.findOne(GtmCampaign, {
      id: policy.campaignId,
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      deletedAt: null,
    }),
    em.findOne(GtmCampaignVersion, {
      id: policy.campaignVersionId,
      campaignId: policy.campaignId,
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      deletedAt: null,
    }),
    em.findOne(GtmPlay, {
      id: policy.playId,
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      deletedAt: null,
    }),
  ])
  if (
    !campaign
    || !version
    || !play
    || campaign.workspaceId !== policy.workspaceId
    || campaign.playId !== policy.playId
    || campaign.currentVersionId !== policy.campaignVersionId
    || !['approved', 'launching', 'active', 'paused'].includes(campaign.status)
    || version.invalidatedAt != null
    || version.contentHash !== policy.campaignContentHash
    || !approvalEnvelopeMatches(version.snapshot, version.contentHash)
  ) {
    const cycle = await blockCycle(em, policy, localDate, 'campaign_version_changed', now)
    return { outcome: 'blocked', cycle, researchRun: null }
  }
  const approved = parseApprovedAutoRefillConfig(version.snapshot)
  const currentPolicyHash = buildAutoRefillPolicyHash({
    policyId: policy.id,
    organizationId: policy.organizationId,
    tenantId: policy.tenantId,
    workspaceId: policy.workspaceId,
    playId: policy.playId,
    campaignId: policy.campaignId,
    campaignVersionId: policy.campaignVersionId,
    representedNoliUserId: policy.representedNoliUserId,
    noliOrganizationId: policy.noliOrganizationId,
    requestedByUserId: policy.requestedByUserId,
    campaignContentHash: policy.campaignContentHash,
    planHash: policy.planHash,
    targetAcceptedPerDay: policy.targetAcceptedPerDay,
    maxRawCandidatesPerDay: policy.maxRawCandidatesPerDay,
    maxCreditsPerDay: policy.maxCreditsPerDay,
    runHourLocal: policy.runHourLocal,
    timezone: policy.timezone,
  })
  if (
    currentPolicyHash !== policy.policyHash
    || approved.autoRefill.plan_hash !== policy.planHash
    || approved.autoRefill.target_accepted_per_day !== policy.targetAcceptedPerDay
    || approved.autoRefill.max_raw_candidates_per_day !== policy.maxRawCandidatesPerDay
    || approved.autoRefill.max_credits_per_day !== policy.maxCreditsPerDay
    || approved.autoRefill.run_hour_local !== policy.runHourLocal
    || approved.timezone !== policy.timezone
  ) {
    const cycle = await blockCycle(em, policy, localDate, 'policy_changed', now)
    return { outcome: 'blocked', cycle, researchRun: null }
  }
  const plan = buildSourcePlan(play, Object.values(deps.adapters), {
    targetAccepted: policy.targetAcceptedPerDay,
    maxRawCandidates: policy.maxRawCandidatesPerDay,
    maxCredits: policy.maxCreditsPerDay,
  })
  if (
    !plan.ok
    || plan.planHash !== policy.planHash
    || !plan.adapterPlan.some((batch) => batch.estimatedCredits <= plan.limits.maxCredits)
  ) {
    const cycle = await blockCycle(em, policy, localDate, 'plan_changed', now)
    return { outcome: 'blocked', cycle, researchRun: null }
  }

  let cycle: GtmAutoRefillCycle
  let run: GtmResearchRun
  try {
    const claimed = await em.transactional(async (tem) => {
      const lockedPolicy = await tem.findOne(GtmAutoRefillPolicy, {
        id: policy.id,
        organizationId: policy.organizationId,
        tenantId: policy.tenantId,
        status: 'active',
        policyHash: policy.policyHash,
        fence: policy.fence,
        deletedAt: null,
      }, { lockMode: LockMode.PESSIMISTIC_WRITE })
      if (!lockedPolicy) return null
      const duplicate = await tem.findOne(GtmAutoRefillCycle, {
        policyId: policy.id,
        organizationId: policy.organizationId,
        tenantId: policy.tenantId,
        localDate,
        deletedAt: null,
      })
      if (duplicate) return { cycle: duplicate, run: null }
      const createdRun = tem.create(GtmResearchRun, {
        id: crypto.randomUUID(),
        organizationId: policy.organizationId,
        tenantId: policy.tenantId,
        workspaceId: policy.workspaceId,
        playId: policy.playId,
        status: 'running',
        inputSnapshot: runInputSnapshot(play, plan),
        providerPlan: runProviderPlan(plan),
        limits: plan.limits,
        estimatedCredits: String(plan.estimatedCredits),
        startedAt: now,
      })
      const createdCycle = tem.create(GtmAutoRefillCycle, {
        id: crypto.randomUUID(),
        organizationId: policy.organizationId,
        tenantId: policy.tenantId,
        policyId: policy.id,
        campaignId: policy.campaignId,
        campaignVersionId: policy.campaignVersionId,
        playId: policy.playId,
        researchRunId: createdRun.id,
        localDate,
        policyHash: policy.policyHash,
        campaignContentHash: policy.campaignContentHash,
        planHash: policy.planHash,
        status: 'running',
        failureCode: null,
        result: null,
        startedAt: now,
        completedAt: null,
      })
      lockedPolicy.lastCycleLocalDate = localDate
      lockedPolicy.lastCycleAt = now
      tem.persist(createdRun)
      tem.persist(createdCycle)
      tem.persist(lockedPolicy)
      tem.persist(tem.create(GtmAuditEvent, {
        organizationId: policy.organizationId,
        tenantId: policy.tenantId,
        actor: 'system',
        actorUserId: null,
        action: 'gtm.auto_refill.cycle_claimed',
        objectType: 'gtm_auto_refill_cycle',
        objectId: createdCycle.id,
        requestId: null,
        metadata: {
          policy_id: policy.id,
          campaign_id: policy.campaignId,
          campaign_version_id: policy.campaignVersionId,
          research_run_id: createdRun.id,
          local_date: localDate,
          policy_hash: policy.policyHash,
          plan_hash: policy.planHash,
          target_accepted_per_day: policy.targetAcceptedPerDay,
          max_raw_candidates_per_day: policy.maxRawCandidatesPerDay,
          max_credits_per_day: policy.maxCreditsPerDay,
        },
      }))
      await tem.flush()
      return { cycle: createdCycle, run: createdRun }
    })
    if (!claimed) return { outcome: 'inactive', cycle: null, researchRun: null }
    if (!claimed.run) return { outcome: 'already_processed', cycle: claimed.cycle, researchRun: null }
    cycle = claimed.cycle
    run = claimed.run
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
    const winner = await existingCycle(em, policy, localDate)
    if (!winner) throw error
    const winnerRun = winner.researchRunId
      ? await em.findOne(GtmResearchRun, {
          id: winner.researchRunId,
          organizationId: policy.organizationId,
          tenantId: policy.tenantId,
          deletedAt: null,
        })
      : null
    return { outcome: 'already_processed', cycle: winner, researchRun: winnerRun }
  }

  try {
    const result = await executeResearchRun({
      em,
      ledger: deps.ledger,
      adapters: deps.adapters,
      run,
      play,
      noliOrgId: input.noliOrganizationId,
      noliUserId: input.representedNoliUserId,
      now: deps.now,
    })
    const finished = await finishCycle(em, policy.id, cycle.id, run, result, deps.now?.() ?? new Date())
    return {
      outcome: finished.status === 'completed'
        ? 'completed'
        : finished.status === 'reconciliation_required' ? 'reconciliation_required' : 'failed',
      cycle: finished,
      researchRun: run,
    }
  } catch {
    const failed = await failCycleAfterException(em, policy, cycle, run, deps.now?.() ?? new Date())
    return {
      outcome: failed.status === 'reconciliation_required' ? 'reconciliation_required' : 'failed',
      cycle: failed,
      researchRun: run,
    }
  }
}
