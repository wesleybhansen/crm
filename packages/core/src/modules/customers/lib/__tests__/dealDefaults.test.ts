import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ensureCustomerDealDefaults } from '../dealDefaults'
import {
  DEAL_STATUS_DEFAULTS,
  PIPELINE_STAGE_DEFAULTS,
  resolveCurrencyCodes,
} from '../dealDefaultsData'
import { CustomerDictionaryEntry, CustomerPipeline, CustomerPipelineStage } from '../../data/entities'
import { Dictionary, DictionaryEntry } from '../../../dictionaries/data/entities'

type Row = Record<string, any> & { __cls: unknown }

/** Minimal in-memory EntityManager: equality filters, persist + flush. */
function createFakeEm(initial: Row[] = []) {
  const rows: Row[] = [...initial]
  const pending: Row[] = []
  const matches = (row: Row, cls: unknown, where: Record<string, unknown>) =>
    row.__cls === cls && Object.entries(where).every(([key, value]) => row[key] === value)
  const em = {
    rows,
    flushes: 0,
    find: jest.fn(async (cls: unknown, where: Record<string, unknown>) => rows.filter((row) => matches(row, cls, where))),
    findOne: jest.fn(async (cls: unknown, where: Record<string, unknown>) => rows.find((row) => matches(row, cls, where)) ?? null),
    count: jest.fn(async (cls: unknown, where: Record<string, unknown>) => rows.filter((row) => matches(row, cls, where)).length),
    create: jest.fn((cls: unknown, data: Record<string, unknown>) => ({ __cls: cls, id: randomUUID(), ...data })),
    persist: jest.fn((row: Row) => {
      if (!rows.includes(row) && !pending.includes(row)) pending.push(row)
    }),
    flush: jest.fn(async () => {
      em.flushes += 1
      rows.push(...pending.splice(0))
    }),
  }
  return em
}

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }
const of = (em: ReturnType<typeof createFakeEm>, cls: unknown) => em.rows.filter((row) => row.__cls === cls)

describe('ensureCustomerDealDefaults', () => {
  it('seeds a default pipeline, stages, deal statuses and currencies for an empty workspace', async () => {
    const em = createFakeEm()
    const result = await ensureCustomerDealDefaults(em as unknown as EntityManager, scope)

    const pipelines = of(em, CustomerPipeline)
    expect(pipelines).toHaveLength(1)
    expect(pipelines[0]).toMatchObject({ ...scope, name: 'Default Pipeline', isDefault: true })

    const stages = of(em, CustomerPipelineStage)
    expect(stages.map((stage) => stage.label)).toEqual(PIPELINE_STAGE_DEFAULTS.map((entry) => entry.label))
    expect(stages.every((stage) => stage.pipelineId === pipelines[0].id)).toBe(true)
    expect(stages.map((stage) => stage.order)).toEqual(PIPELINE_STAGE_DEFAULTS.map((_, index) => index))

    const statuses = of(em, CustomerDictionaryEntry)
    expect(statuses.map((entry) => entry.value)).toEqual(DEAL_STATUS_DEFAULTS.map((entry) => entry.value))
    expect(statuses.every((entry) => entry.kind === 'deal_status' && entry.organizationId === 'org-1')).toBe(true)

    const dictionaries = of(em, Dictionary)
    expect(dictionaries).toHaveLength(1)
    expect(dictionaries[0]).toMatchObject({ ...scope, key: 'currency', isActive: true })
    const currencies = of(em, DictionaryEntry)
    expect(currencies.length).toBe(resolveCurrencyCodes().length)
    expect(currencies.map((entry) => entry.value)).toEqual(expect.arrayContaining(['USD', 'EUR']))
    expect(currencies.find((entry) => entry.value === 'USD')).toMatchObject({ normalizedValue: 'usd', dictionary: dictionaries[0] })

    expect(result).toEqual({
      pipelineCreated: true,
      stagesCreated: PIPELINE_STAGE_DEFAULTS.length,
      dealStatusesCreated: DEAL_STATUS_DEFAULTS.length,
      currencyDictionaryCreated: true,
      currenciesCreated: resolveCurrencyCodes().length,
    })
  })

  it('is idempotent: a second run adds nothing', async () => {
    const em = createFakeEm()
    await ensureCustomerDealDefaults(em as unknown as EntityManager, scope)
    const countAfterFirst = em.rows.length
    const flushesAfterFirst = em.flushes

    const second = await ensureCustomerDealDefaults(em as unknown as EntityManager, scope)
    expect(em.rows.length).toBe(countAfterFirst)
    expect(em.flushes).toBe(flushesAfterFirst)
    expect(second).toEqual({
      pipelineCreated: false,
      stagesCreated: 0,
      dealStatusesCreated: 0,
      currencyDictionaryCreated: false,
      currenciesCreated: 0,
    })
  })

  it('leaves a workspace pipeline that already has stages alone', async () => {
    const pipeline = { __cls: CustomerPipeline, id: 'p-1', ...scope, name: 'Listings', isDefault: false }
    const stage = { __cls: CustomerPipelineStage, id: 's-1', ...scope, pipelineId: 'p-1', label: 'Lead', order: 0 }
    const em = createFakeEm([pipeline, stage])
    const result = await ensureCustomerDealDefaults(em as unknown as EntityManager, scope)
    expect(of(em, CustomerPipeline)).toEqual([pipeline])
    expect(of(em, CustomerPipelineStage)).toEqual([stage])
    expect(result.pipelineCreated).toBe(false)
    expect(result.stagesCreated).toBe(0)
  })

  it('adds stages to an existing pipeline that has none', async () => {
    const pipeline = { __cls: CustomerPipeline, id: 'p-1', ...scope, name: 'Sales', isDefault: true }
    const em = createFakeEm([pipeline])
    await ensureCustomerDealDefaults(em as unknown as EntityManager, scope)
    expect(of(em, CustomerPipeline)).toHaveLength(1)
    const stages = of(em, CustomerPipelineStage)
    expect(stages).toHaveLength(PIPELINE_STAGE_DEFAULTS.length)
    expect(stages.every((entry) => entry.pipelineId === 'p-1')).toBe(true)
  })

  it('keeps existing deal statuses and only adds the missing ones', async () => {
    const custom = {
      __cls: CustomerDictionaryEntry, id: 'd-1', ...scope, kind: 'deal_status',
      value: 'Open', normalizedValue: 'open', label: 'Active', color: null, icon: null,
    }
    const em = createFakeEm([custom])
    const result = await ensureCustomerDealDefaults(em as unknown as EntityManager, scope)
    const statuses = of(em, CustomerDictionaryEntry)
    expect(statuses.filter((entry) => entry.normalizedValue === 'open')).toEqual([custom])
    expect(result.dealStatusesCreated).toBe(DEAL_STATUS_DEFAULTS.length - 1)
  })

  it('restores a soft-deleted currency dictionary instead of creating a duplicate', async () => {
    const dictionary = { __cls: Dictionary, id: 'dict-1', ...scope, key: 'currency', isActive: true, deletedAt: new Date() }
    const em = createFakeEm([dictionary])
    const result = await ensureCustomerDealDefaults(em as unknown as EntityManager, scope)
    expect(of(em, Dictionary)).toHaveLength(1)
    expect(dictionary.deletedAt).toBeNull()
    expect(result.currencyDictionaryCreated).toBe(false)
    expect(result.currenciesCreated).toBe(resolveCurrencyCodes().length)
  })

  it('does not touch another workspace', async () => {
    const other = { __cls: CustomerPipeline, id: 'p-other', tenantId: 'tenant-1', organizationId: 'org-2', name: 'Other', isDefault: true }
    const em = createFakeEm([other])
    await ensureCustomerDealDefaults(em as unknown as EntityManager, scope)
    expect(of(em, CustomerPipeline).filter((row) => row.organizationId === 'org-1')).toHaveLength(1)
    expect(of(em, CustomerPipelineStage).every((row) => row.organizationId === 'org-1')).toBe(true)
  })

  it('requires a tenant and organization', async () => {
    const em = createFakeEm()
    await expect(
      ensureCustomerDealDefaults(em as unknown as EntityManager, { tenantId: 'tenant-1', organizationId: '' }),
    ).rejects.toThrow(/organizationId/)
  })
})
