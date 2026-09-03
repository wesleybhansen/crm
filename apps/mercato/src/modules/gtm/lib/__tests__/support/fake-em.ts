import crypto from 'crypto'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import {
  GtmCampaignVersion,
  GtmAiTelemetry,
  GtmAutoRefillCycle,
  GtmAutoRefillPolicy,
  GtmCandidate,
  GtmCandidateMatch,
  GtmCandidateRelation,
  GtmChatMessage,
  GtmDeletionRequest,
  GtmDsrOperation,
  GtmEnrollment,
  GtmIcpVersion,
  GtmInboundEvent,
  GtmMailboxCursor,
  GtmMailboxHealth,
  GtmMailboxPolicy,
  GtmProviderReconciliationAction,
  GtmProviderOperation,
  GtmReply,
  GtmRenderedMessage,
  GtmSendAttempt,
  GtmSuppression,
  GtmVoiceVersion,
} from '../../../data/entities'
import type { ResearchEm } from '../../research/execute'
import type { RetentionEm } from '../../retention/sweep'
import type { CampaignEm } from '../../campaign/build'
import type { ExecutionEm } from '../../execute/schedule'
import type { ListEm } from '../../listing'

/*
 * In-memory structural stand-in for MikroORM's EntityManager, covering
 * exactly the slices the gtm library code uses (ResearchEm + RetentionEm +
 * CampaignEm + ExecutionEm). It enforces the constraints the library code
 * must handle race-safely: the unique (organization_id, workspace_id,
 * dedupe_key) index on gtm_candidates, (campaign_id, candidate_id) on
 * gtm_enrollments, (enrollment_id, step_id) on gtm_rendered_messages,
 * (campaign_id, version) on gtm_campaign_versions, (organization_id,
 * idempotency_key) on gtm_send_attempts, and (organization_id, channel,
 * address_hash) on gtm_suppressions all throw
 * UniqueConstraintViolationException at flush time, before anything in the
 * pending batch is inserted (mirroring a Postgres transaction abort).
 * `find` supports the narrow where-operator vocabulary the libraries use:
 * equality, null, { $in }, { $nin }, { $lte }, { $lt }, { $gte }, { $ne },
 * { $ilike } (Postgres ILIKE semantics: % and _ are wildcards unless
 * backslash-escaped, comparison case-insensitive), and a top-level
 * { $or: [...] }.
 *
 * `nativeUpdate` mirrors MikroORM's conditional UPDATE ... WHERE semantics:
 * the match + assignment happens synchronously in one step (no awaited gap),
 * which is exactly the compare-and-swap atomicity a single Postgres UPDATE
 * statement provides. The Tranche 6 claim/fence machinery is exercised
 * against these semantics.
 *
 * Two modes:
 *
 *   - default (`new FakeEm()`): the stored row IS the entity object handed to
 *     callers, so a nativeUpdate is immediately visible on any reference a
 *     test holds. Convenient, but it hides an entire class of ORM lifecycle
 *     bug: a managed entity mutated after a nativeUpdate is flushed back over
 *     the row by the next transaction commit (the C1 review finding).
 *
 *   - identity map (`new FakeEm({ identityMap: true })` or
 *     `em.fork({ identityMap: true })`): stored rows and the entities handed
 *     to callers are DISTINCT objects, exactly like MikroORM. find/findOne
 *     return one managed entity per row (merged from the row except for
 *     properties the caller changed and never flushed, mirroring
 *     EntityFactory.mergeData), nativeUpdate touches only the stored rows,
 *     and BOTH `flush()` and the end of `transactional()` write every dirty
 *     managed entity back to its row (TransactionManager forks with
 *     clear:false and flushes on commit). `fork()` shares the rows with a
 *     fresh identity map. Use this mode for tests whose subject is the ORM
 *     lifecycle itself (execution-tick multi-attempt ticks).
 */
export type FakeEmOptions = { identityMap?: boolean }

export class FakeEm implements ResearchEm, RetentionEm, CampaignEm, ExecutionEm, ListEm {
  private rows: Map<Function, object[]>
  private pending: object[] = []
  private pendingRemovals: object[] = []
  private readonly identityMap: boolean
  // identity-map mode only: stored row -> managed entity, and the snapshot of
  // the entity as last loaded/flushed (MikroORM's __originalEntityData).
  private managed = new Map<object, object>()
  private original = new Map<object, Record<string, unknown>>()

  constructor(options: FakeEmOptions = {}, shared?: { rows: Map<Function, object[]> }) {
    this.rows = shared?.rows ?? new Map<Function, object[]>()
    this.identityMap = options.identityMap === true
  }

  // Shares the stored rows, starts with an empty identity map (MikroORM
  // `em.fork()` with the default clear:true). In default mode the fork is
  // this same instance: rows and entities are one object anyway.
  fork(options: FakeEmOptions = {}): FakeEm {
    const identityMap = options.identityMap ?? this.identityMap
    if (!identityMap) return this
    return new FakeEm({ identityMap: true }, { rows: this.rows })
  }

  table<T extends object>(Ctor: new () => T): T[] {
    return (this.rows.get(Ctor) ?? []) as T[]
  }

  async transactional<T>(cb: (tem: FakeEm) => Promise<T>): Promise<T> {
    try {
      const result = await cb(this)
      // Commit: MikroORM's TransactionManager flushes the (copied) identity
      // map, which writes back EVERY dirty managed entity, not only the ones
      // touched inside the callback.
      if (this.identityMap) this.writeBackDirty()
      return result
    } finally {
      // Anything persisted but never flushed inside the callback is dropped,
      // and a throw leaves previously flushed tables untouched (the fake
      // flush is all-or-nothing per batch).
      this.pending = []
      this.pendingRemovals = []
    }
  }

  create<T extends object>(Ctor: new () => T, data: object): T {
    const entity = new Ctor()
    Object.assign(entity, data)
    const withId = entity as { id?: string }
    if (!withId.id) withId.id = crypto.randomUUID()
    return entity
  }

  persist(entity: object): unknown {
    this.pending.push(entity)
    return this
  }

  remove(entity: object): unknown {
    this.pendingRemovals.push(entity)
    return this
  }

  // ---------------------------------------------------------------------
  // identity-map mode plumbing
  // ---------------------------------------------------------------------

  private snapshot(entity: object): Record<string, unknown> {
    return { ...(entity as Record<string, unknown>) }
  }

  private rowOf(entity: object): object | null {
    if (!this.identityMap) return entity
    for (const [row, managed] of this.managed) {
      if (managed === entity) return row
    }
    return null
  }

  // Returns the managed entity for a stored row, merging the row's current
  // values into it except for properties the caller changed since the last
  // load/flush (mergeData: "do not override values changed by user").
  private hydrate<T extends object>(row: T): T {
    if (!this.identityMap) return row
    const existing = this.managed.get(row) as T | undefined
    if (existing) {
      const original = this.original.get(existing) ?? {}
      const current = existing as Record<string, unknown>
      const source = row as Record<string, unknown>
      for (const key of Object.keys(source)) {
        const dirty = key in original ? current[key] !== original[key] : current[key] !== undefined
        if (dirty) continue
        current[key] = source[key]
        original[key] = source[key]
      }
      this.original.set(existing, original)
      return existing
    }
    const entity = Object.assign(new (row.constructor as new () => T)(), row)
    this.managed.set(row, entity)
    this.original.set(entity, this.snapshot(entity))
    return entity
  }

  // Writes every dirty managed entity back to its stored row.
  private writeBackDirty(): void {
    for (const [row, entity] of this.managed) {
      const original = this.original.get(entity) ?? {}
      const current = entity as Record<string, unknown>
      const target = row as Record<string, unknown>
      for (const key of Object.keys(current)) {
        if (key in original && current[key] === original[key]) continue
        if (!(key in original) && current[key] === undefined) continue
        target[key] = current[key]
        original[key] = current[key]
      }
      this.original.set(entity, original)
    }
  }

  // Optional orderBy/limit mirror the MikroORM find options the list helpers
  // use (lib/listing.ts); callers that omit them behave exactly as before.
  async find<T extends object>(
    Ctor: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]> {
    let rows = this.table(Ctor).filter((row) => matchesWhere(row, where))
    if (options?.orderBy) {
      const keys = Object.entries(options.orderBy)
      rows = [...rows].sort((a, b) => {
        for (const [key, direction] of keys) {
          const cmp = compareBound(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key],
          )
          if (cmp != null && cmp !== 0) return direction === 'desc' ? -cmp : cmp
        }
        return 0
      })
    }
    if (options?.limit != null) rows = rows.slice(0, options.limit)
    return rows.map((row) => this.hydrate(row))
  }

  async findOne<T extends object>(
    Ctor: new () => T,
    where: Record<string, unknown>,
  ): Promise<T | null> {
    const row = this.table(Ctor).find((row) => matchesWhere(row, where)) ?? null
    return row ? this.hydrate(row) : null
  }

  // Conditional UPDATE ... WHERE, atomic per call (single-threaded JS: no
  // awaited gap between match and assignment), mirroring one SQL statement.
  // Touches stored rows only: in identity-map mode a managed entity keeps
  // its stale values until it is re-read, exactly like MikroORM.
  async nativeUpdate<T extends object>(
    Ctor: new () => T,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number> {
    const matched = this.table(Ctor).filter((row) => matchesWhere(row, where))
    for (const row of matched) Object.assign(row, data)
    return matched.length
  }

  async flush(): Promise<void> {
    // Validate the whole pending batch first so a violation inserts nothing.
    for (const entity of this.pending) {
      if (entity instanceof GtmCandidate) {
        const own = this.rowOf(entity)
        const duplicate = this.table(GtmCandidate).some(
          (row) =>
            row !== entity &&
            row !== own &&
            row.organizationId === entity.organizationId &&
            row.workspaceId === entity.workspaceId &&
            row.dedupeKey === entity.dedupeKey,
        )
        if (duplicate) {
          this.pending = []
          throw new UniqueConstraintViolationException(
            new Error(`duplicate key value violates unique constraint: ${entity.dedupeKey}`),
          )
        }
      }
      if (entity instanceof GtmCandidateMatch) {
        this.assertUnique(
          entity,
          GtmCandidateMatch,
          (row) => row.researchRunId === entity.researchRunId && row.candidateId === entity.candidateId,
          'gtm_candidate_matches_run_candidate_unique',
        )
      }
      if (entity instanceof GtmCandidateRelation) {
        this.assertUnique(
          entity,
          GtmCandidateRelation,
          (row) =>
            row.researchRunId === entity.researchRunId
            && row.parentCandidateId === entity.parentCandidateId
            && row.childCandidateId === entity.childCandidateId
            && row.relationshipKind === entity.relationshipKind,
          'gtm_candidate_relations_run_parent_child_kind_unique',
        )
      }
      if (entity instanceof GtmEnrollment) {
        this.assertUnique(
          entity,
          GtmEnrollment,
          (row) => row.campaignId === entity.campaignId && row.candidateId === entity.candidateId,
          'gtm_enrollments_campaign_candidate_unique',
        )
      }
      if (entity instanceof GtmRenderedMessage) {
        this.assertUnique(
          entity,
          GtmRenderedMessage,
          (row) => row.enrollmentId === entity.enrollmentId && row.stepId === entity.stepId,
          'gtm_rendered_messages_enrollment_step_unique',
        )
      }
      if (entity instanceof GtmCampaignVersion) {
        this.assertUnique(
          entity,
          GtmCampaignVersion,
          (row) => row.campaignId === entity.campaignId && row.version === entity.version,
          'gtm_campaign_versions_campaign_version_unique',
        )
      }
      if (entity instanceof GtmAutoRefillPolicy) {
        this.assertUnique(
          entity,
          GtmAutoRefillPolicy,
          (row) =>
            row.organizationId === entity.organizationId
            && row.tenantId === entity.tenantId
            && row.campaignId === entity.campaignId,
          'gtm_auto_refill_policies_org_tenant_campaign_unique',
        )
      }
      if (entity instanceof GtmAutoRefillCycle) {
        this.assertUnique(
          entity,
          GtmAutoRefillCycle,
          (row) => row.policyId === entity.policyId && row.localDate === entity.localDate,
          'gtm_auto_refill_cycles_policy_local_date_unique',
        )
      }
      if (entity instanceof GtmIcpVersion) {
        this.assertUnique(
          entity,
          GtmIcpVersion,
          (row) => row.workspaceId === entity.workspaceId && row.version === entity.version,
          'gtm_icp_versions_workspace_version_unique',
        )
      }
      if (entity instanceof GtmVoiceVersion) {
        this.assertUnique(
          entity,
          GtmVoiceVersion,
          (row) => row.workspaceId === entity.workspaceId && row.version === entity.version,
          'gtm_voice_versions_workspace_version_unique',
        )
      }
      if (entity instanceof GtmChatMessage) {
        this.assertUnique(
          entity,
          GtmChatMessage,
          (row) => row.threadId === entity.threadId && row.seq === entity.seq,
          'gtm_chat_messages_thread_seq_unique',
        )
      }
      if (entity instanceof GtmSendAttempt) {
        this.assertUnique(
          entity,
          GtmSendAttempt,
          (row) =>
            row.organizationId === entity.organizationId &&
            row.idempotencyKey === entity.idempotencyKey,
          'gtm_send_attempts_org_idempotency_unique',
        )
        if (entity.capacitySlotKey) {
          this.assertUnique(
            entity,
            GtmSendAttempt,
            (row) =>
              row.organizationId === entity.organizationId &&
              row.capacitySlotKey === entity.capacitySlotKey,
            'gtm_send_attempts_org_capacity_slot_unique',
          )
        }
      }
      if (entity instanceof GtmSuppression) {
        this.assertUnique(
          entity,
          GtmSuppression,
          (row) =>
            row.organizationId === entity.organizationId &&
            row.channel === entity.channel &&
            row.addressHash === entity.addressHash,
          'gtm_suppressions_org_channel_address_unique',
        )
      }
      if (entity instanceof GtmProviderReconciliationAction) {
        this.assertUnique(
          entity,
          GtmProviderReconciliationAction,
          (row) =>
            row.organizationId === entity.organizationId &&
            row.idempotencyKey === entity.idempotencyKey,
          'gtm_provider_reconciliation_actions_org_key_unique',
        )
      }
      if (entity instanceof GtmProviderOperation) {
        this.assertUnique(
          entity,
          GtmProviderOperation,
          (row) => row.noliCoreOperationId === entity.noliCoreOperationId,
          'gtm_provider_operations_noli_core_operation_unique',
        )
      }
      if (entity instanceof GtmMailboxCursor) {
        this.assertUnique(
          entity,
          GtmMailboxCursor,
          (row) =>
            row.organizationId === entity.organizationId &&
            row.tenantId === entity.tenantId &&
            row.mailboxConnectionId === entity.mailboxConnectionId &&
            row.provider === entity.provider &&
            row.cursorKind === entity.cursorKind,
          'gtm_mailbox_cursors_mailbox_provider_kind_unique',
        )
      }
      if (entity instanceof GtmMailboxHealth) {
        this.assertUnique(
          entity,
          GtmMailboxHealth,
          (row) =>
            row.organizationId === entity.organizationId &&
            row.tenantId === entity.tenantId &&
            row.mailboxConnectionId === entity.mailboxConnectionId,
          'gtm_mailbox_health_org_tenant_mailbox_unique',
        )
      }
      if (entity instanceof GtmMailboxPolicy) {
        this.assertUnique(
          entity,
          GtmMailboxPolicy,
          (row) =>
            row.organizationId === entity.organizationId &&
            row.tenantId === entity.tenantId &&
            row.mailboxConnectionId === entity.mailboxConnectionId,
          'gtm_mailbox_policies_org_tenant_mailbox_unique',
        )
      }
      if (entity instanceof GtmAiTelemetry) {
        this.assertUnique(
          entity,
          GtmAiTelemetry,
          (row) =>
            row.organizationId === entity.organizationId &&
            row.operationKey === entity.operationKey,
          'gtm_ai_telemetry_org_operation_unique',
        )
      }
      if (entity instanceof GtmInboundEvent) {
        this.assertUnique(
          entity,
          GtmInboundEvent,
          (row) =>
            row.organizationId === entity.organizationId &&
            row.tenantId === entity.tenantId &&
            row.dedupeKey === entity.dedupeKey,
          'gtm_inbound_events_org_tenant_dedupe_unique',
        )
      }
      if (entity instanceof GtmReply) {
        if (entity.inboundEventId) {
          this.assertUnique(
            entity,
            GtmReply,
            (row) =>
              row.organizationId === entity.organizationId &&
              row.tenantId === entity.tenantId &&
              row.inboundEventId === entity.inboundEventId,
            'gtm_replies_org_tenant_event_unique',
          )
        }
        if (entity.emailMessageId) {
          this.assertUnique(
            entity,
            GtmReply,
            (row) =>
              row.organizationId === entity.organizationId &&
              row.tenantId === entity.tenantId &&
              row.emailMessageId === entity.emailMessageId,
            'gtm_replies_org_tenant_message_unique',
          )
        }
        if (entity.stepId) {
          this.assertUnique(
            entity,
            GtmReply,
            (row) =>
              row.organizationId === entity.organizationId &&
              row.tenantId === entity.tenantId &&
              row.enrollmentId === entity.enrollmentId &&
              row.stepId === entity.stepId,
            'gtm_replies_org_tenant_social_step_unique',
          )
        }
      }
      if (entity instanceof GtmDeletionRequest) {
        this.assertUnique(
          entity,
          GtmDeletionRequest,
          (row) =>
            row.organizationId === entity.organizationId &&
            row.idempotencyKey === entity.idempotencyKey,
          'gtm_deletion_requests_org_key_unique',
        )
      }
      if (entity instanceof GtmDsrOperation) {
        this.assertUnique(
          entity,
          GtmDsrOperation,
          (row) =>
            row.deletionRequestId === entity.deletionRequestId &&
            row.organizationId === entity.organizationId &&
            row.provider === entity.provider &&
            row.kind === entity.kind,
          'gtm_dsr_operations_request_org_provider_kind_unique',
        )
      }
    }
    for (const entity of this.pending) {
      const Ctor = entity.constructor as new () => object
      const arr = this.rows.get(Ctor) ?? []
      if (this.identityMap) {
        // A brand-new entity gets its own stored row; an already-managed one
        // is written back below with every other dirty entity.
        if (!this.rowOf(entity)) {
          const row = Object.assign(new Ctor(), entity)
          arr.push(row)
          this.managed.set(row, entity)
          this.original.set(entity, this.snapshot(entity))
        }
      } else if (!arr.includes(entity)) {
        arr.push(entity)
      }
      this.rows.set(Ctor, arr)
    }
    this.pending = []
    if (this.identityMap) this.writeBackDirty()
    for (const entity of this.pendingRemovals) {
      const Ctor = entity.constructor as new () => object
      const arr = this.rows.get(Ctor) ?? []
      const row = this.rowOf(entity) ?? entity
      const index = arr.indexOf(row)
      if (index >= 0) arr.splice(index, 1)
      if (this.identityMap) {
        this.managed.delete(row)
        this.original.delete(entity)
      }
      this.rows.set(Ctor, arr)
    }
    this.pendingRemovals = []
  }

  private assertUnique<T extends object>(
    entity: T,
    Ctor: new () => T,
    conflicts: (row: T) => boolean,
    constraint: string,
  ): void {
    const own = this.rowOf(entity)
    const duplicate = this.table(Ctor).some((row) => row !== entity && row !== own && conflicts(row))
    if (duplicate) {
      this.pending = []
      throw new UniqueConstraintViolationException(
        new Error(`duplicate key value violates unique constraint "${constraint}"`),
      )
    }
  }
}

// Narrow where matcher: equality, null, { $in }, { $nin }, { $lte }, { $lt },
// { $gte }, { $ne }, { $ilike }, plus a top-level { $or: [subWhere, ...] }.

// Postgres ILIKE: `%` matches any run, `_` any single char, `\` escapes the
// next character (the default ESCAPE), comparison is case-insensitive.
function ilikeMatches(value: unknown, pattern: unknown): boolean {
  if (typeof value !== 'string' || typeof pattern !== 'string') return false
  let regex = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '\\') {
      i += 1
      if (i < pattern.length) regex += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      continue
    }
    if (char === '%') regex += '.*'
    else if (char === '_') regex += '.'
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${regex}$`, 'i').test(value)
}

function compareBound(value: unknown, bound: unknown): number | null {
  if (value == null || bound == null) return null
  if (value instanceof Date && bound instanceof Date) {
    return value.getTime() - bound.getTime()
  }
  const a = value as number | string
  const b = bound as number | string
  return a < b ? -1 : a > b ? 1 : 0
}

function matchesWhere(row: object, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === '$or') {
      const branches = Array.isArray(condition) ? (condition as Record<string, unknown>[]) : []
      if (!branches.some((branch) => matchesWhere(row, branch))) return false
      continue
    }
    const value = (row as Record<string, unknown>)[key]
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const ops = condition as Record<string, unknown>
      if ('$in' in ops) {
        if (!Array.isArray(ops.$in) || !ops.$in.includes(value)) return false
      }
      if ('$nin' in ops) {
        if (Array.isArray(ops.$nin) && ops.$nin.includes(value)) return false
      }
      if ('$ne' in ops) {
        if (value === ops.$ne) return false
        if (ops.$ne === null && value == null) return false
      }
      if ('$lte' in ops) {
        const cmp = compareBound(value, ops.$lte)
        if (cmp === null || cmp > 0) return false
      }
      if ('$lt' in ops) {
        const cmp = compareBound(value, ops.$lt)
        if (cmp === null || cmp >= 0) return false
      }
      if ('$gte' in ops) {
        const cmp = compareBound(value, ops.$gte)
        if (cmp === null || cmp < 0) return false
      }
      if ('$gt' in ops) {
        const cmp = compareBound(value, ops.$gt)
        if (cmp === null || cmp <= 0) return false
      }
      if ('$ilike' in ops) {
        if (!ilikeMatches(value, ops.$ilike)) return false
      }
      continue
    }
    if (condition === null) {
      if (value != null) return false
      continue
    }
    if (value !== condition) return false
  }
  return true
}
