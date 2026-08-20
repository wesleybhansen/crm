import crypto from 'crypto'
import { GtmAuditEvent, GtmIcpVersion, GtmVoiceVersion, GtmWorkspace } from '../data/entities'
import type { CampaignEm, GtmCtx } from './campaign/build'

/*
 * ICP and Voice Profile version CRUD + locks (SPEC-066 section 4 and 4.3:
 * reviewable, versioned, lockable, attributable, revertible).
 *
 * Both gtm_icp_versions and gtm_voice_versions are append-only version chains
 * keyed by (workspace_id, version). The invariants enforced here:
 *
 *  - Immutable history: content is NEVER edited in place. "Editing" is always
 *    a new version (version = max + 1) whose content is the caller's new
 *    document. Older versions stay exactly as approved/authored.
 *  - Lock: locking stamps locked / locked_by_user_id / locked_at on a row.
 *    That stamp is the only mutation a version row ever takes (mirroring the
 *    campaign-version invalidation stamp). Unlock clears it.
 *  - Attribution: every version carries provenance {author: 'user' | 'agent',
 *    ...source refs}. The agent may PROPOSE new versions, but when the latest
 *    version is locked an agent-authored write is rejected: a human has to
 *    unlock (or author the next version themselves) before the agent can move
 *    the strategy again. User-authored writes are always allowed.
 *  - Revert: creates a NEW version copying an older version's content, never
 *    mutating or resurrecting the old row.
 *
 * Every mutation writes a redacted GtmAuditEvent in the same transaction and
 * is self-scoped by organization_id + tenant_id. Content text is never copied
 * into audit metadata (only versions, ids, author).
 */

export const GTM_VERSION_LIST_CAP = 50

export type VersionKind = 'icp' | 'voice'
export type VersionAuthor = 'user' | 'agent'

export class GtmVersionError extends Error {
  constructor(
    public code:
      | 'workspace_not_found'
      | 'version_not_found'
      | 'invalid_content'
      | 'locked_rejects_agent',
    message: string,
  ) {
    super(message)
    this.name = 'GtmVersionError'
  }
}

// A version document is a plain JSON object. The route validates shape; this
// is the last-line guard so a non-object can never reach the jsonb column.
function assertContent(content: unknown): Record<string, unknown> {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new GtmVersionError('invalid_content', 'Version content must be a JSON object')
  }
  return content as Record<string, unknown>
}

type VersionEntity = GtmIcpVersion | GtmVoiceVersion

type VersionCtor = typeof GtmIcpVersion | typeof GtmVoiceVersion

function ctorFor(kind: VersionKind): VersionCtor {
  return kind === 'icp' ? GtmIcpVersion : GtmVoiceVersion
}

function actionPrefix(kind: VersionKind): string {
  return kind === 'icp' ? 'gtm.icp' : 'gtm.voice'
}

function objectType(kind: VersionKind): string {
  return kind === 'icp' ? 'gtm_icp_version' : 'gtm_voice_version'
}

export async function requireWorkspace(em: CampaignEm, ctx: GtmCtx, workspaceId: string): Promise<GtmWorkspace> {
  const workspace = await em.findOne(GtmWorkspace, {
    id: workspaceId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!workspace) throw new GtmVersionError('workspace_not_found', 'Workspace not found')
  return workspace
}

// Self-scoped version list, newest version first, capped.
export async function listVersions(
  em: CampaignEm,
  ctx: GtmCtx,
  kind: VersionKind,
  workspaceId: string,
): Promise<VersionEntity[]> {
  const Ctor = ctorFor(kind) as new () => VersionEntity
  const rows = await (em as CampaignEm & {
    find<T extends object>(
      c: new () => T,
      w: Record<string, unknown>,
      o?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
    ): Promise<T[]>
  }).find(
    Ctor,
    {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      workspaceId,
      deletedAt: null,
    },
    { orderBy: { version: 'desc' }, limit: GTM_VERSION_LIST_CAP },
  )
  return rows
}

export async function getVersion(
  em: CampaignEm,
  ctx: GtmCtx,
  kind: VersionKind,
  workspaceId: string,
  versionId: string,
): Promise<VersionEntity> {
  const Ctor = ctorFor(kind) as new () => VersionEntity
  const row = await em.findOne(Ctor, {
    id: versionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    workspaceId,
    deletedAt: null,
  })
  if (!row) throw new GtmVersionError('version_not_found', 'Version not found')
  return row
}

// The latest version in the chain (highest version number), or null.
async function latestVersion(
  em: CampaignEm,
  ctx: GtmCtx,
  kind: VersionKind,
  workspaceId: string,
): Promise<VersionEntity | null> {
  const rows = await listVersions(em, ctx, kind, workspaceId)
  if (rows.length === 0) return null
  return rows.reduce((top, row) => (row.version > top.version ? row : top), rows[0])
}

// The highest-version LOCKED row for the workspace, or null. The locked voice
// (and ICP) is what grounds AI drafting: only a reviewed, locked document is
// trusted to steer generated copy.
export async function getLatestLockedVersion(
  em: CampaignEm,
  ctx: GtmCtx,
  kind: VersionKind,
  workspaceId: string,
): Promise<VersionEntity | null> {
  const rows = await listVersions(em, ctx, kind, workspaceId)
  const locked = rows.filter((row) => row.locked)
  if (locked.length === 0) return null
  return locked.reduce((top, row) => (row.version > top.version ? row : top), locked[0])
}

// Guard the "locked doc rejects agent writes" rule: an agent-authored write
// (create / revert / derive) is refused when the current latest version is
// locked. A human must supersede or unlock it first.
function assertAgentMayWrite(latest: VersionEntity | null, author: VersionAuthor): void {
  if (author === 'agent' && latest?.locked) {
    throw new GtmVersionError(
      'locked_rejects_agent',
      'The current version is locked; an agent cannot supersede a locked document. Unlock it first.',
    )
  }
}

export type CreateVersionInput = {
  workspaceId: string
  content: Record<string, unknown>
  author?: VersionAuthor
  // extra provenance source refs merged under { author, ... }
  provenance?: Record<string, unknown>
  // voice only: website / sent-mail / pasted / social provenance
  derivedFrom?: Record<string, unknown> | null
}

// Create the next immutable version in the chain. Never edits an existing row.
export async function createVersion(
  em: CampaignEm,
  ctx: GtmCtx,
  kind: VersionKind,
  input: CreateVersionInput,
): Promise<VersionEntity> {
  await requireWorkspace(em, ctx, input.workspaceId)
  const content = assertContent(input.content)
  const author: VersionAuthor = input.author ?? 'user'

  const latest = await latestVersion(em, ctx, kind, input.workspaceId)
  assertAgentMayWrite(latest, author)
  const nextVersion = (latest?.version ?? 0) + 1

  const Ctor = ctorFor(kind)
  const row = await em.transactional(async (tem) => {
    const id = crypto.randomUUID()
    const data: Record<string, unknown> = {
      id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      workspaceId: input.workspaceId,
      version: nextVersion,
      content,
      locked: false,
      lockedByUserId: null,
      lockedAt: null,
      provenance: { author, ...(input.provenance ?? {}) },
    }
    if (kind === 'voice') data.derivedFrom = input.derivedFrom ?? null
    const created = tem.create(Ctor as new () => VersionEntity, data)
    tem.persist(created)
    tem.persist(
      tem.create(GtmAuditEvent, auditData(ctx, kind, author, 'version_created', created.id, nextVersion, {
        workspace_id: input.workspaceId,
      })),
    )
    await tem.flush()
    return created
  })
  return row
}

// Revert = a NEW version whose content is copied from an older version. The
// source row is never mutated; history is preserved.
export async function revertVersion(
  em: CampaignEm,
  ctx: GtmCtx,
  kind: VersionKind,
  input: { workspaceId: string; sourceVersionId: string; author?: VersionAuthor },
): Promise<VersionEntity> {
  await requireWorkspace(em, ctx, input.workspaceId)
  const source = await getVersion(em, ctx, kind, input.workspaceId, input.sourceVersionId)
  const author: VersionAuthor = input.author ?? 'user'

  const latest = await latestVersion(em, ctx, kind, input.workspaceId)
  assertAgentMayWrite(latest, author)
  const nextVersion = (latest?.version ?? 0) + 1

  const Ctor = ctorFor(kind)
  // Deep clone so the new row never shares a reference with the source jsonb.
  const clonedContent = JSON.parse(JSON.stringify(source.content ?? {})) as Record<string, unknown>
  const derivedFrom =
    kind === 'voice'
      ? ((source as GtmVoiceVersion).derivedFrom ?? null)
      : undefined

  const row = await em.transactional(async (tem) => {
    const id = crypto.randomUUID()
    const data: Record<string, unknown> = {
      id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      workspaceId: input.workspaceId,
      version: nextVersion,
      content: clonedContent,
      locked: false,
      lockedByUserId: null,
      lockedAt: null,
      provenance: {
        author,
        reverted_from_version: source.version,
        reverted_from_id: source.id,
      },
    }
    if (kind === 'voice') data.derivedFrom = derivedFrom ?? null
    const created = tem.create(Ctor as new () => VersionEntity, data)
    tem.persist(created)
    tem.persist(
      tem.create(GtmAuditEvent, auditData(ctx, kind, author, 'version_reverted', created.id, nextVersion, {
        workspace_id: input.workspaceId,
        reverted_from_version: source.version,
        reverted_from_id: source.id,
      })),
    )
    await tem.flush()
    return created
  })
  return row
}

// Lock / unlock. Idempotent: locking a locked row (or unlocking an unlocked
// one) returns the row unchanged with no audit noise.
export async function setVersionLock(
  em: CampaignEm,
  ctx: GtmCtx,
  kind: VersionKind,
  input: { workspaceId: string; versionId: string; locked: boolean },
): Promise<VersionEntity> {
  const row = await getVersion(em, ctx, kind, input.workspaceId, input.versionId)
  if (row.locked === input.locked) return row

  await em.transactional(async (tem) => {
    row.locked = input.locked
    if (input.locked) {
      row.lockedByUserId = ctx.userId
      row.lockedAt = new Date()
    } else {
      row.lockedByUserId = null
      row.lockedAt = null
    }
    tem.persist(row)
    tem.persist(
      tem.create(
        GtmAuditEvent,
        auditData(ctx, kind, 'user', input.locked ? 'version_locked' : 'version_unlocked', row.id, row.version, {
          workspace_id: input.workspaceId,
        }),
      ),
    )
    await tem.flush()
  })
  return row
}

function auditData(
  ctx: GtmCtx,
  kind: VersionKind,
  author: VersionAuthor,
  action: string,
  objectId: string,
  objectVersion: number,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    actor: author === 'agent' ? 'agent' : 'user_id',
    actorUserId: author === 'agent' ? null : ctx.userId,
    action: `${actionPrefix(kind)}.${action}`,
    objectType: objectType(kind),
    objectId,
    objectVersion,
    requestId: ctx.requestId ?? null,
    metadata,
  }
}

// Serializable shape for the internal route / hub UI (no ORM entity leakage).
export function versionShape(kind: VersionKind, row: VersionEntity) {
  const base = {
    id: row.id,
    workspace_id: row.workspaceId,
    version: row.version,
    content: row.content,
    locked: row.locked,
    locked_by_user_id: row.lockedByUserId ?? null,
    locked_at: row.lockedAt ?? null,
    provenance: row.provenance ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
  if (kind === 'voice') {
    return { ...base, derived_from: (row as GtmVoiceVersion).derivedFrom ?? null }
  }
  return base
}
