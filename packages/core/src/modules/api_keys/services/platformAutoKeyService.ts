import { createHash, createHmac } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { User } from '@open-mercato/core/modules/auth/data/entities'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { ApiKey } from '../data/entities'
import { hashApiKey, verifyApiKey } from './apiKeyService'

const PLATFORM_AUTO_V2_PREFIX = 'platform-auto:v2:'
const PLATFORM_AUTO_LEGACY_PREFIX = 'platform-auto:'
const DEFAULT_OVERLAP_SECONDS = 10 * 60
const MIN_OVERLAP_SECONDS = 60
const MAX_OVERLAP_SECONDS = 60 * 60
const MAX_CREDENTIAL_VERSION = 2_147_483_647
export const DEFAULT_PLATFORM_AUTO_LEGACY_CUTOFF_MS = Date.parse('2026-08-04T00:00:00.000Z')
export const ABSOLUTE_PLATFORM_AUTO_LEGACY_CUTOFF_MS = Date.parse('2026-08-21T00:00:00.000Z')

export type ParsedPlatformAutoKeyName = {
  noliUserId: string
  sourceFingerprint: string
  version: number
}

export type ProvisionPlatformAutoApiKeyInput = {
  noliUserId: string
  source: string
  version: number
  derivationSecret: string
  overlapSeconds: number
  tenantId: string | null
  organizationId: string
  roles: string[]
  createdBy: string
}

export type ProvisionPlatformAutoApiKeyResult = {
  record: ApiKey
  secret: string
  version: number
  overlapSeconds: number
  reused: boolean
}

function encodeNoliUserId(noliUserId: string): string {
  return Buffer.from(noliUserId, 'utf8').toString('base64url')
}

function decodeNoliUserId(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
    return decoded && encodeNoliUserId(decoded) === encoded ? decoded : null
  } catch {
    return null
  }
}

export function platformAutoSourceFingerprint(source: string): string {
  return createHash('sha256').update(source.trim()).digest('hex').slice(0, 24)
}

export function platformAutoKeyName(noliUserId: string, source: string, version: number): string {
  return `${PLATFORM_AUTO_V2_PREFIX}${encodeNoliUserId(noliUserId)}:${platformAutoSourceFingerprint(source)}:${version}`
}

export function parsePlatformAutoKeyName(name: string): ParsedPlatformAutoKeyName | null {
  if (!name.startsWith(PLATFORM_AUTO_V2_PREFIX)) return null
  const remainder = name.slice(PLATFORM_AUTO_V2_PREFIX.length)
  const parts = remainder.split(':')
  if (parts.length !== 3 || !/^[a-f0-9]{24}$/.test(parts[1]) || !/^\d+$/.test(parts[2])) {
    return null
  }
  const noliUserId = decodeNoliUserId(parts[0])
  const version = Number(parts[2])
  if (
    !noliUserId ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > MAX_CREDENTIAL_VERSION
  ) {
    return null
  }
  return { noliUserId, sourceFingerprint: parts[1], version }
}

export function isPlatformAutoKeyName(name: string): boolean {
  return name.startsWith(PLATFORM_AUTO_LEGACY_PREFIX)
}

export function getPlatformAutoCredentialVersion(raw: string | undefined): number {
  if (!raw?.trim()) return 1
  const version = Number(raw)
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_CREDENTIAL_VERSION) {
    throw new Error('NOLI_COS_CRM_KEY_VERSION must be a positive integer')
  }
  return version
}

export function getPlatformAutoOverlapSeconds(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_OVERLAP_SECONDS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_OVERLAP_SECONDS
  return Math.min(MAX_OVERLAP_SECONDS, Math.max(MIN_OVERLAP_SECONDS, Math.floor(parsed)))
}

export function getPlatformAutoLegacyCutoffMs(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_PLATFORM_AUTO_LEGACY_CUTOFF_MS
  const parsed = Date.parse(raw)
  // A malformed explicit shortening must not silently widen the weaker legacy
  // acceptance window back to its default.
  if (!Number.isFinite(parsed)) return 0
  return Math.min(parsed, ABSOLUTE_PLATFORM_AUTO_LEGACY_CUTOFF_MS)
}

export function isLegacyPlatformAutoKeyUsable(
  nowMs = Date.now(),
  configuredCutoff = process.env.NOLI_COS_CRM_LEGACY_ACCEPT_UNTIL,
): boolean {
  return nowMs < getPlatformAutoLegacyCutoffMs(configuredCutoff)
}

export function derivePlatformAutoApiKeySecret(input: {
  derivationSecret: string
  tenantId: string | null
  organizationId: string
  noliUserId: string
  sourceFingerprint: string
  version: number
}): { secret: string; prefix: string } {
  if (input.derivationSecret.length < 32) {
    throw new Error('NOLI_COS_CREDENTIAL_DERIVATION_SECRET must be at least 32 characters')
  }
  const digest = createHmac('sha256', input.derivationSecret)
    .update(
      JSON.stringify([
        'noli:crm:platform-auto:v2',
        input.tenantId,
        input.organizationId,
        input.noliUserId,
        input.sourceFingerprint,
        input.version,
      ]),
    )
    .digest('hex')
  const secret = `omk_${digest.slice(0, 8)}.${digest.slice(8)}`
  return { secret, prefix: secret.slice(0, 12) }
}

function capExpiration(record: ApiKey, deadline: Date): void {
  if (!record.expiresAt || record.expiresAt.getTime() > deadline.getTime()) {
    record.expiresAt = deadline
  }
}

/**
 * Provision an idempotent, recoverable platform key. The transaction lock is
 * deliberately scoped to one local org + noli user + source, so teammates can
 * provision concurrently without sharing or revoking credentials.
 */
export async function provisionPlatformAutoApiKey(
  em: EntityManager,
  input: ProvisionPlatformAutoApiKeyInput,
): Promise<ProvisionPlatformAutoApiKeyResult> {
  const sourceFingerprint = platformAutoSourceFingerprint(input.source)
  const encodedUser = encodeNoliUserId(input.noliUserId)
  const namePrefix = `${PLATFORM_AUTO_V2_PREFIX}${encodedUser}:${sourceFingerprint}:`
  const legacyName = `${PLATFORM_AUTO_LEGACY_PREFIX}${input.source}`
  const overlapSeconds = getPlatformAutoOverlapSeconds(String(input.overlapSeconds))

  return em.transactional(async (tx) => {
    const lockKey = `platform-auto:${input.tenantId ?? 'global'}:${input.organizationId}:${input.noliUserId}:${sourceFingerprint}`
    // EntityManager.execute carries MikroORM's active transaction context.
    // getKnex().raw() would use the global Knex connection and release this
    // transaction-scoped lock as soon as that standalone statement finished.
    await tx.execute('select pg_advisory_xact_lock(hashtext(?))', [lockKey])

    // Include deleted rows when finding the highest version. A soft-deleted
    // deterministic credential must never be silently resurrected.
    const versionRows = await tx.find(ApiKey, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      name: { $like: `${namePrefix}%` },
    })
    // Legacy rows can arrive after the first v2 mint from a delayed old
    // deployment. Read them under the same lock before either branch mutates
    // managed entities, so stable v2 retries also bound that late key.
    const legacyRows = await tx.find(ApiKey, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      createdBy: input.createdBy,
      name: legacyName,
      deletedAt: null,
    })
    const parsedRows = versionRows
      .map((record) => ({
        record,
        parsed: parsePlatformAutoKeyName(record.name),
      }))
      .filter(
        (entry): entry is { record: ApiKey; parsed: ParsedPlatformAutoKeyName } =>
          entry.parsed !== null &&
          entry.parsed.noliUserId === input.noliUserId &&
          entry.parsed.sourceFingerprint === sourceFingerprint,
      )
      .sort((a, b) => b.parsed.version - a.parsed.version)
    const latest = parsedRows[0]

    if (latest && latest.parsed.version >= input.version) {
      if (
        latest.record.deletedAt ||
        (latest.record.expiresAt && latest.record.expiresAt.getTime() <= Date.now())
      ) {
        throw new Error('Latest platform-auto credential version is revoked')
      }
      const derived = derivePlatformAutoApiKeySecret({
        derivationSecret: input.derivationSecret,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        noliUserId: input.noliUserId,
        sourceFingerprint,
        version: latest.parsed.version,
      })
      if (
        latest.record.keyPrefix !== derived.prefix ||
        !(await verifyApiKey(derived.secret, latest.record.keyHash))
      ) {
        throw new Error('Credential derivation secret does not match the stored key')
      }

      // Re-provisioning also refreshes the user's current CRM roles without
      // changing the raw credential.
      // Refresh every still-present generation. A predecessor retained for
      // overlap must not keep permissions the user has just lost; preserve its
      // original fixed expiry while updating only identity/role metadata.
      for (const entry of parsedRows) {
        if (entry.record.deletedAt) continue
        entry.record.rolesJson = [...input.roles]
        entry.record.tenantId = input.tenantId
        entry.record.createdBy = input.createdBy
      }
      const deadline = new Date(Date.now() + overlapSeconds * 1000)
      for (const record of legacyRows) {
        record.rolesJson = [...input.roles]
        capExpiration(record, deadline)
      }
      await tx.flush()
      return {
        record: latest.record,
        secret: derived.secret,
        version: latest.parsed.version,
        overlapSeconds,
        reused: true,
      }
    }

    // Legacy keys used an org+source name. createdBy is the only safe way to
    // attribute them, so only this user's rows receive the transition deadline.
    // Perform every read before mutating managed entities. MikroORM queries can
    // refresh the identity map and otherwise discard unflushed scalar changes.
    const now = new Date()
    const deadline = new Date(now.getTime() + overlapSeconds * 1000)
    for (const entry of parsedRows) {
      if (entry.record.deletedAt) continue
      // A credential retained for overlap must not retain permissions the user
      // has just lost. The route invalidates the corresponding RBAC cache after
      // this transaction commits.
      entry.record.rolesJson = [...input.roles]
      entry.record.tenantId = input.tenantId
      entry.record.createdBy = input.createdBy
      // Retain exactly the current generation. Older version rows must not
      // accumulate across rapid bumps while each overlap is still live.
      capExpiration(entry.record, entry === latest ? deadline : now)
    }
    for (const record of legacyRows) {
      record.rolesJson = [...input.roles]
      capExpiration(record, latest ? now : deadline)
    }

    const name = platformAutoKeyName(input.noliUserId, input.source, input.version)
    const derived = derivePlatformAutoApiKeySecret({
      derivationSecret: input.derivationSecret,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      noliUserId: input.noliUserId,
      sourceFingerprint,
      version: input.version,
    })
    const record = tx.create(ApiKey, {
      name,
      description: `Auto-minted for Noli ${input.source} connectivity`,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      keyHash: await hashApiKey(derived.secret),
      keyPrefix: derived.prefix,
      rolesJson: [...input.roles],
      createdBy: input.createdBy,
      expiresAt: null,
      createdAt: new Date(),
    })
    tx.persist(record)
    await tx.flush()

    return {
      record,
      secret: derived.secret,
      version: input.version,
      overlapSeconds,
      reused: false,
    }
  })
}

/** Fail-closed use-time validation for both v2 and transition-era legacy rows. */
export async function isPlatformAutoApiKeyAuthorized(
  em: EntityManager,
  apiKey: ApiKey,
): Promise<boolean> {
  if (!isPlatformAutoKeyName(apiKey.name)) return true
  if (!apiKey.createdBy || !apiKey.organizationId) return false

  try {
    const localUser = await em.findOne(User, {
      id: apiKey.createdBy,
      tenantId: apiKey.tenantId ?? null,
      organizationId: apiKey.organizationId,
      isConfirmed: true,
      deletedAt: null,
    })
    if (!localUser?.clerkUserId) return false

    const localOrg = await em.findOne(Organization, {
      id: apiKey.organizationId,
      isActive: true,
      deletedAt: null,
    })
    if (!localOrg?.noliOrgId) return false

    const parsed = parsePlatformAutoKeyName(apiKey.name)
    if (apiKey.name.startsWith(PLATFORM_AUTO_V2_PREFIX) && !parsed) return false
    if (!parsed && !isLegacyPlatformAutoKeyUsable()) return false
    const { findNoliUserById, findUserByClerkId, hasNoliOrgMembership, isEntitled } =
      await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = parsed
      ? await findNoliUserById(parsed.noliUserId)
      : await findUserByClerkId(localUser.clerkUserId)
    if (!noliUser || noliUser.clerk_user_id !== localUser.clerkUserId) return false
    if (parsed && noliUser.id !== parsed.noliUserId) return false

    const [entitled, linkedToOrg] = await Promise.all([
      isEntitled(noliUser.id, 'crm'),
      hasNoliOrgMembership(noliUser.id, localOrg.noliOrgId),
    ])
    return entitled && linkedToOrg
  } catch {
    // noli-core is the authority. A lookup outage must not turn into an auth
    // bypass, and no credential or user identifier should reach logs here.
    console.warn('[api-key-auth] platform-auto authorization check unavailable')
    return false
  }
}
