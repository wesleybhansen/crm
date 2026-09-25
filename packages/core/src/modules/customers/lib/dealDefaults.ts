/**
 * Everything a workspace (organization) needs before a deal can be created:
 * a default pipeline with stages, the deal status dictionary and the currency
 * dictionary. Without them the deal form has empty Pipeline, Stage, Status and
 * Currency pickers and `GET /api/customers/dictionaries/currency` returns 404.
 *
 * `ensureCustomerDealDefaults` is idempotent (it only adds what is missing and
 * never renames or removes anything a user set up), flushes its own changes,
 * and uses relative imports only, so it is safe to call from sign-in
 * provisioning, commands, CLI scripts and workers.
 */
import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerDictionaryEntry, CustomerPipeline, CustomerPipelineStage } from '../data/entities'
import { Dictionary, DictionaryEntry } from '../../dictionaries/data/entities'
import {
  CURRENCY_DICTIONARY_KEY,
  DEAL_STATUS_DEFAULTS,
  DEFAULT_PIPELINE_NAME,
  PIPELINE_STAGE_DEFAULTS,
  resolveCurrencyCodes,
  resolveCurrencyLabel,
} from './dealDefaultsData'

export type CustomerDealDefaultsScope = {
  tenantId: string
  organizationId: string
}

export type CustomerDealDefaultsResult = {
  pipelineCreated: boolean
  stagesCreated: number
  dealStatusesCreated: number
  currencyDictionaryCreated: boolean
  currenciesCreated: number
}

/** Adds the default deal status entries (kind `deal_status`) that are missing. */
export async function ensureDealStatusDictionary(
  em: EntityManager,
  { tenantId, organizationId }: CustomerDealDefaultsScope,
): Promise<number> {
  const existing = await em.find(CustomerDictionaryEntry, { tenantId, organizationId, kind: 'deal_status' })
  const seen = new Set(existing.map((entry) => entry.normalizedValue))
  let created = 0
  for (const entry of DEAL_STATUS_DEFAULTS) {
    const normalized = entry.value.trim().toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    em.persist(em.create(CustomerDictionaryEntry, {
      tenantId,
      organizationId,
      kind: 'deal_status',
      value: entry.value,
      normalizedValue: normalized,
      label: entry.label,
      color: entry.color ?? null,
      icon: entry.icon ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    created += 1
  }
  if (created) await em.flush()
  return created
}

/**
 * Makes sure the organization has a pipeline with stages. When it has none,
 * creates "Default Pipeline" with the default stages. When its default (or
 * oldest) pipeline has no stages, adds the default stages to it. A workspace
 * that already has a staged pipeline is left alone.
 */
export async function ensureDefaultDealPipeline(
  em: EntityManager,
  { tenantId, organizationId }: CustomerDealDefaultsScope,
): Promise<{ pipelineCreated: boolean; stagesCreated: number }> {
  const pipelines = await em.find(
    CustomerPipeline,
    { tenantId, organizationId },
    { orderBy: { createdAt: 'asc' } },
  )
  let pipeline = pipelines.find((entry) => entry.isDefault) ?? pipelines[0] ?? null
  let pipelineCreated = false
  if (!pipeline) {
    const fresh = em.create(CustomerPipeline, {
      tenantId,
      organizationId,
      name: DEFAULT_PIPELINE_NAME,
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    em.persist(fresh)
    try {
      await em.flush()
      pipeline = fresh
      pipelineCreated = true
    } catch (err) {
      // customer_pipelines_one_default_per_org: a concurrent call created the
      // default first. Use the winner (it seeds its own stages).
      const code = (err as { code?: string })?.code
      if (code !== '23505' && !/unique|duplicate key/i.test(String(err))) throw err
      em.clear()
      const winner = await em.findOne(CustomerPipeline, { tenantId, organizationId, isDefault: true })
      if (!winner) throw err
      return { pipelineCreated: false, stagesCreated: 0 }
    }
  } else {
    const stageCount = await em.count(CustomerPipelineStage, { tenantId, organizationId, pipelineId: pipeline.id })
    if (stageCount > 0) return { pipelineCreated, stagesCreated: 0 }
  }
  PIPELINE_STAGE_DEFAULTS.forEach((entry, index) => {
    em.persist(em.create(CustomerPipelineStage, {
      tenantId,
      organizationId,
      pipelineId: pipeline!.id,
      label: entry.label,
      order: index,
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
  })
  await em.flush()
  return { pipelineCreated, stagesCreated: PIPELINE_STAGE_DEFAULTS.length }
}

/**
 * Makes sure the organization has a `currency` dictionary holding every
 * ISO 4217 code. A soft-deleted one is restored rather than duplicated (the
 * table is unique on org + key); one an admin switched off stays off.
 * Existing entries are never relabelled or removed.
 */
export async function ensureCurrencyDictionary(
  em: EntityManager,
  { tenantId, organizationId }: CustomerDealDefaultsScope,
): Promise<{ created: boolean; entriesCreated: number }> {
  let dictionary = await em.findOne(Dictionary, { tenantId, organizationId, key: CURRENCY_DICTIONARY_KEY })
  let created = false
  if (!dictionary) {
    dictionary = em.create(Dictionary, {
      key: CURRENCY_DICTIONARY_KEY,
      name: 'Currencies',
      description: 'ISO 4217 currencies',
      tenantId,
      organizationId,
      isSystem: true,
      isActive: true,
      managerVisibility: 'default',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    em.persist(dictionary)
    await em.flush()
    created = true
  } else if (dictionary.deletedAt) {
    dictionary.deletedAt = null
    dictionary.updatedAt = new Date()
    em.persist(dictionary)
    await em.flush()
  }

  const existing = await em.find(DictionaryEntry, { dictionary, tenantId, organizationId })
  const seen = new Set(existing.map((entry) => entry.normalizedValue))
  let entriesCreated = 0
  for (const code of resolveCurrencyCodes()) {
    const normalized = code.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    em.persist(em.create(DictionaryEntry, {
      dictionary,
      tenantId,
      organizationId,
      value: code,
      normalizedValue: normalized,
      label: resolveCurrencyLabel(code),
      color: null,
      icon: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    entriesCreated += 1
  }
  if (entriesCreated) await em.flush()
  return { created, entriesCreated }
}

/**
 * Seeds a workspace's deal defaults: default pipeline + stages, deal statuses
 * and the currency dictionary. Idempotent; call it for a new organization and
 * again any time (re-runs add nothing).
 */
export async function ensureCustomerDealDefaults(
  em: EntityManager,
  scope: CustomerDealDefaultsScope,
): Promise<CustomerDealDefaultsResult> {
  if (!scope?.tenantId || !scope?.organizationId) {
    throw new Error('ensureCustomerDealDefaults requires tenantId and organizationId')
  }
  const { pipelineCreated, stagesCreated } = await ensureDefaultDealPipeline(em, scope)
  const dealStatusesCreated = await ensureDealStatusDictionary(em, scope)
  const currency = await ensureCurrencyDictionary(em, scope)
  return {
    pipelineCreated,
    stagesCreated,
    dealStatusesCreated,
    currencyDictionaryCreated: currency.created,
    currenciesCreated: currency.entriesCreated,
  }
}
