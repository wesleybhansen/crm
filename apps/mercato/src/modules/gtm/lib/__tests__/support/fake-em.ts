import crypto from 'crypto'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import {
  GtmCampaignVersion,
  GtmCandidate,
  GtmChatMessage,
  GtmEnrollment,
  GtmIcpVersion,
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
 */
export class FakeEm implements ResearchEm, RetentionEm, CampaignEm, ExecutionEm, ListEm {
  private rows = new Map<Function, object[]>()
  private pending: object[] = []
  private pendingRemovals: object[] = []

  table<T extends object>(Ctor: new () => T): T[] {
    return (this.rows.get(Ctor) ?? []) as T[]
  }

  async transactional<T>(cb: (tem: FakeEm) => Promise<T>): Promise<T> {
    try {
      return await cb(this)
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
    return rows
  }

  async findOne<T extends object>(
    Ctor: new () => T,
    where: Record<string, unknown>,
  ): Promise<T | null> {
    return this.table(Ctor).find((row) => matchesWhere(row, where)) ?? null
  }

  // Conditional UPDATE ... WHERE, atomic per call (single-threaded JS: no
  // awaited gap between match and assignment), mirroring one SQL statement.
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
        const duplicate = this.table(GtmCandidate).some(
          (row) =>
            row !== entity &&
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
    }
    for (const entity of this.pending) {
      const Ctor = entity.constructor as new () => object
      const arr = this.rows.get(Ctor) ?? []
      if (!arr.includes(entity)) arr.push(entity)
      this.rows.set(Ctor, arr)
    }
    this.pending = []
    for (const entity of this.pendingRemovals) {
      const Ctor = entity.constructor as new () => object
      const arr = this.rows.get(Ctor) ?? []
      const index = arr.indexOf(entity)
      if (index >= 0) arr.splice(index, 1)
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
    const duplicate = this.table(Ctor).some((row) => row !== entity && conflicts(row))
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
