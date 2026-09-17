import crypto from 'node:crypto'
import { CURRENT_ENVELOPE_VERSION, generateDek, hashForLookup } from './aes'
import { isEncryptionDebugEnabled, isTenantDataEncryptionEnabled } from './toggles'

export type TenantDek = {
  tenantId: string
  key: string // base64
  fetchedAt: number
}

export interface KmsService {
  getTenantDek(tenantId: string): Promise<TenantDek | null>
  createTenantDek(tenantId: string): Promise<TenantDek | null>
  isHealthy(): boolean
}

class FallbackKmsService implements KmsService {
  private notified = false
  constructor(
    private readonly primary: KmsService,
    private readonly fallback: KmsService | null,
    private readonly onFallback?: () => void,
  ) {}

  isHealthy(): boolean {
    return this.primary.isHealthy() || Boolean(this.fallback?.isHealthy?.())
  }

  private notifyFallback() {
    if (this.notified) return
    this.notified = true
    this.onFallback?.()
  }

  private async fromPrimary<T>(op: () => Promise<T | null>): Promise<T | null> {
    try {
      return await op()
    } catch (err) {
      console.warn('⚠️ [encryption][kms] Primary KMS failed, will try fallback', {
        error: (err as Error)?.message || String(err),
      })
      return null
    }
  }

  async getTenantDek(tenantId: string): Promise<TenantDek | null> {
    if (this.primary.isHealthy()) {
      const dek = await this.fromPrimary(() => this.primary.getTenantDek(tenantId))
      if (dek) return dek
    }
    if (this.fallback?.isHealthy()) {
      this.notifyFallback()
      return this.fallback.getTenantDek(tenantId)
    }
    return null
  }

  async createTenantDek(tenantId: string): Promise<TenantDek | null> {
    if (this.primary.isHealthy()) {
      const dek = await this.fromPrimary(() => this.primary.createTenantDek(tenantId))
      if (dek) return dek
    }
    if (this.fallback?.isHealthy()) {
      this.notifyFallback()
      return this.fallback.createTenantDek(tenantId)
    }
    return null
  }
}

type VaultClientOpts = {
  vaultAddr?: string
  vaultToken?: string
  mountPath?: string
  ttlMs?: number
}

type VaultReadResponse = {
  data?: { data?: { key?: string; version?: number }; metadata?: Record<string, unknown> }
}

function normalizeEnv(value: string | undefined): string {
  if (!value) return ''
  return value.trim().replace(/(?:^['"]|['"]$)/g, '')
}

type DerivedSecret = { secret: string; source: 'explicit' | 'dev-default'; envName: string }

/**
 * The dedicated tenant-data key, in priority order.
 *
 * TENANT_DATA_ENCRYPTION_KEY is the variable to set. TENANT_DATA_ENCRYPTION_FALLBACK_KEY
 * is what production is running on today and stays supported so a deploy that
 * has not set the new variable yet keeps reading the same key; it logs one
 * startup warning naming the variable to set.
 *
 * AUTH_SECRET / NEXTAUTH_SECRET are deliberately NOT candidates. Deriving the
 * data key from the session secret silently re-keys every encrypted row the day
 * that secret rotates, and a session secret is handled far more casually than a
 * data key. They were accepted here once; they never are again.
 */
export const TENANT_DATA_KEY_ENV = 'TENANT_DATA_ENCRYPTION_KEY'
export const TENANT_DATA_FALLBACK_KEY_ENV = 'TENANT_DATA_ENCRYPTION_FALLBACK_KEY'

let loggedFallbackVariableWarning = false

function resolveDerivedKeySecret(): DerivedSecret | null {
  const candidates: Array<{ value: string | null; envName: string }> = [
    { value: process.env[TENANT_DATA_KEY_ENV] ?? null, envName: TENANT_DATA_KEY_ENV },
    { value: process.env[TENANT_DATA_FALLBACK_KEY_ENV] ?? null, envName: TENANT_DATA_FALLBACK_KEY_ENV },
  ]
  for (const raw of candidates) {
    const normalized = normalizeEnv(raw.value ?? undefined)
    if (!normalized) continue
    if (raw.envName === TENANT_DATA_FALLBACK_KEY_ENV && !loggedFallbackVariableWarning && process.env.NODE_ENV !== 'test') {
      loggedFallbackVariableWarning = true
      console.warn(
        `\u26a0\ufe0f [encryption][kms] Tenant data keys are derived from ${TENANT_DATA_FALLBACK_KEY_ENV}. ` +
          `Set ${TENANT_DATA_KEY_ENV} to the dedicated data key; the fallback variable is kept only for the transition.`,
      )
    }
    return { secret: normalized, source: 'explicit', envName: raw.envName }
  }
  if (process.env.NODE_ENV !== 'production') {
    return { secret: 'om-dev-tenant-encryption', source: 'dev-default', envName: 'DEV_DEFAULT' }
  }
  return null
}

export class NoopKmsService implements KmsService {
  isHealthy(): boolean { return !isTenantDataEncryptionEnabled() }
  async getTenantDek(): Promise<TenantDek | null> { return null }
  async createTenantDek(): Promise<TenantDek | null> { return null }
}

class DerivedKmsService implements KmsService {
  private root: Buffer
  constructor(secret: string) {
    // Derive a stable root key from the provided secret so derived tenant keys are deterministic
    this.root = crypto.createHash('sha256').update(secret).digest()
  }

  isHealthy(): boolean {
    return true
  }

  private deriveKey(tenantId: string): string {
    const iterations = 310_000
    const keyLength = 32
    const derived = crypto.pbkdf2Sync(this.root, tenantId, iterations, keyLength, 'sha512')
    return derived.toString('base64')
  }

  async getTenantDek(tenantId: string): Promise<TenantDek | null> {
    if (!tenantId) return null
    return { tenantId, key: this.deriveKey(tenantId), fetchedAt: Date.now() }
  }

  async createTenantDek(tenantId: string): Promise<TenantDek | null> {
    return this.getTenantDek(tenantId)
  }
}

export class HashicorpVaultKmsService implements KmsService {
  private cache = new Map<string, TenantDek>()
  private readonly vaultAddr: string
  private readonly vaultToken: string
  private readonly mountPath: string
  private readonly ttlMs: number
  private healthy = true
  private readonly debugEnabled: boolean
  private static loggedInit = false

  constructor(opts: VaultClientOpts = {}) {
    this.vaultAddr = normalizeEnv(opts.vaultAddr || process.env.VAULT_ADDR || '')
    this.vaultToken = normalizeEnv(opts.vaultToken || process.env.VAULT_TOKEN || '')
    this.mountPath = (opts.mountPath || process.env.VAULT_KV_PATH || 'secret/data').replace(/\/+$/, '')
    this.ttlMs = opts.ttlMs ?? 15 * 60 * 1000
    this.debugEnabled = isEncryptionDebugEnabled()
    if (!this.vaultAddr || !this.vaultToken) {
      this.healthy = false
      if (this.debugEnabled) {
        console.warn('⚠️ [encryption][kms] Vault misconfigured (missing VAULT_ADDR or VAULT_TOKEN)')
      }
    }
    if (this.healthy && !HashicorpVaultKmsService.loggedInit && this.debugEnabled) {
      HashicorpVaultKmsService.loggedInit = true
      if(this.debugEnabled) {
        console.info('🔐 [encryption][kms] Hashicorp Vault KMS enabled')
      }
    }
  }

  isHealthy(): boolean {
    return this.healthy
  }

  private now(): number {
    return Date.now()
  }

  private cacheHit(tenantId: string): TenantDek | null {
    const entry = this.cache.get(tenantId)
    if (!entry) return null
    if (this.now() - entry.fetchedAt > this.ttlMs) {
      this.cache.delete(tenantId)
      return null
    }
    return entry
  }

  private async readVault(path: string): Promise<VaultReadResponse | null> {
    if (!this.vaultAddr || !this.vaultToken) {
      this.healthy = false
      return null
    }
    try {
      const res = await fetch(`${this.vaultAddr}/v1/${path}`, {
        method: 'GET',
        headers: { 'X-Vault-Token': this.vaultToken },
      })
      if (!res.ok) {
        this.healthy = res.status < 500
        console.warn('⚠️ [encryption][kms] Vault read failed', { path, status: res.status })
        return null
      }
      if (this.debugEnabled) {
        console.info('🔍 [encryption][kms] Vault read ok', { path })
      }
      return (await res.json()) as VaultReadResponse
    } catch (err) {
      this.healthy = false
      console.warn('⚠️ [encryption][kms] Vault read error', { path, error: (err as Error)?.message || String(err) })
      return null
    }
  }

  private async writeVault(path: string, key: string): Promise<boolean> {
    if (!this.vaultAddr || !this.vaultToken) {
      this.healthy = false
      return false
    }
    try {
      const res = await fetch(`${this.vaultAddr}/v1/${path}`, {

        method: 'POST',
        headers: {
          'X-Vault-Token': this.vaultToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: { key } }),
      })
      this.healthy = res.ok
      if (!res.ok) {
        console.warn('⚠️ [encryption][kms] Vault write failed', { path, status: res.status })
      }
      return res.ok
    } catch (err) {
      this.healthy = false
      console.warn('⚠️ [encryption][kms] Vault write error', { path, error: (err as Error)?.message || String(err) })
      return false
    }
  }

  private buildKeyPath(tenantId: string): string {
    const suffix = `tenant_key_${tenantId}`
    const normalizedMount = this.mountPath.replace(/^\/+/, '')
    return `${normalizedMount}/${suffix}`
  }

  private remember(entry: TenantDek): TenantDek {
    this.cache.set(entry.tenantId, entry)
    return entry
  }

  async getTenantDek(tenantId: string): Promise<TenantDek | null> {
    const cached = this.cacheHit(tenantId)
    if (cached) return cached
    const path = this.buildKeyPath(tenantId)
    const res = await this.readVault(path)
    const key = res?.data?.data?.key
    if (!key) {
      console.warn('⚠️ [encryption][kms] No tenant DEK found in Vault', { tenantId, path })
      return null
    }
    const dek: TenantDek = { tenantId, key, fetchedAt: this.now() }
    return this.remember(dek)
  }

  async createTenantDek(tenantId: string): Promise<TenantDek | null> {
    const key = generateDek()
    const path = this.buildKeyPath(tenantId)
    const ok = await this.writeVault(path, key)
    if (ok) {
      console.info('🔑 [encryption][kms] Stored tenant DEK in Vault', { tenantId, path })
    } else {
      console.warn('⚠️ [encryption][kms] Failed to store tenant DEK in Vault', { tenantId, path })
    }
    if (!ok) return null
    return this.remember({ tenantId, key, fetchedAt: this.now() })
  }
}

/* ---------------------------------------------------------------------------
 * Key source
 *
 * TENANT_KMS_PROVIDER picks it. Default: `derived`.
 *
 *   derived (default) - per-tenant keys are PBKDF2-derived from
 *                       TENANT_DATA_ENCRYPTION_KEY (or the legacy
 *                       TENANT_DATA_ENCRYPTION_FALLBACK_KEY). One key source,
 *                       one failure mode: the variable is missing, and the
 *                       process refuses to start rather than quietly writing
 *                       PII as plaintext.
 *   vault             - opt in to HashiCorp Vault as the primary source, with
 *                       the derived scheme as fallback.
 *
 * Vault used to be the unconditional primary. A restart leaves Vault sealed
 * until somebody unseals it, and the old ordering treated a sealed Vault as
 * "try the fallback", which silently moved every tenant onto a different key;
 * the swap surfaced as garbled names, not an error. The unseal shares also live
 * on the same host as Vault, so it bought no key separation. Retired as primary
 * on 2026-09-16; the client code below stays compiled and reachable behind
 * TENANT_KMS_PROVIDER=vault so an existing Vault install can still be read.
 *
 * TENANT_DATA_KMS is the previous name for this switch and is still honoured.
 * ------------------------------------------------------------------------- */
export type TenantKmsProvider = 'derived' | 'vault'

export const TENANT_KMS_PROVIDER_ENV = 'TENANT_KMS_PROVIDER'
export const LEGACY_TENANT_KMS_PROVIDER_ENV = 'TENANT_DATA_KMS'
export const DEFAULT_TENANT_KMS_PROVIDER: TenantKmsProvider = 'derived'

export function resolveTenantKmsProvider(): TenantKmsProvider {
  const raw =
    normalizeEnv(process.env[TENANT_KMS_PROVIDER_ENV]).toLowerCase()
    || normalizeEnv(process.env[LEGACY_TENANT_KMS_PROVIDER_ENV]).toLowerCase()
  if (raw === 'vault') return 'vault'
  return DEFAULT_TENANT_KMS_PROVIDER
}

let loggedKmsBanner = false

/** Test seam: let a suite observe the banner more than once. */
export function resetKmsBannerForTests(): void {
  loggedKmsBanner = false
  loggedFallbackVariableWarning = false
}

function logKmsBanner(provider: TenantKmsProvider, derived: DerivedSecret | null): void {
  if (loggedKmsBanner || process.env.NODE_ENV === 'test') return
  loggedKmsBanner = true
  const keySource = derived
    ? derived.source === 'dev-default'
      ? 'dev default secret (NOT for production)'
      : derived.envName
    : 'none'
  // Never the key, never a hash of it: the scheme, the variable name, and
  // whether envelopes carry a key id. That is everything an operator needs to
  // tell "the deploy read my new variable" from "it did not".
  const line =
    `[encryption][kms] scheme=${provider} key_variable=${keySource} `
    + `envelope=${CURRENT_ENVELOPE_VERSION} key_id=active`
  if (derived?.source === 'dev-default') console.warn(`\u26a0\ufe0f ${line}`)
  else console.info(`\ud83d\udd10 ${line}`)
}

export function createKmsService(): KmsService {
  if (!isTenantDataEncryptionEnabled()) return new NoopKmsService()

  const provider = resolveTenantKmsProvider()
  const derived = resolveDerivedKeySecret()

  if (provider === 'derived') {
    if (!derived) {
      // Fail closed. Encryption is on and the derived scheme is the only key
      // source, so a missing secret must not quietly turn every PII write into
      // plaintext. Throwing stops the process at boot, which is the loud
      // failure this deserves.
      throw new Error(
        `Tenant data encryption is enabled but neither ${TENANT_DATA_KEY_ENV} nor ${TENANT_DATA_FALLBACK_KEY_ENV} is set; `
          + 'refusing to run with tenant data encryption silently disabled',
      )
    }
    logKmsBanner(provider, derived)
    return new DerivedKmsService(derived.secret)
  }

  // provider === 'vault' (explicit opt-in only)
  logKmsBanner(provider, derived)
  const primary = new HashicorpVaultKmsService()
  const fallback = derived ? new DerivedKmsService(derived.secret) : null

  if (!primary.isHealthy()) {
    if (fallback) {
      console.warn(
        `\u26a0\ufe0f [encryption][kms] ${TENANT_KMS_PROVIDER_ENV}=vault but Vault is unhealthy or misconfigured; `
          + `using derived keys from ${derived?.envName}`,
      )
      return fallback
    }
    console.warn(
      `\u26a0\ufe0f [encryption][kms] ${TENANT_KMS_PROVIDER_ENV}=vault, Vault is unhealthy and no derived secret is set; falling back to noop KMS`,
    )
    return new NoopKmsService()
  }

  if (fallback) return new FallbackKmsService(primary, fallback)

  return primary
}

export { hashForLookup }
