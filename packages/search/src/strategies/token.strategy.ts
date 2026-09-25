import type { Knex } from 'knex'
import type {
  SearchStrategy,
  SearchStrategyId,
  SearchOptions,
  SearchResult,
  IndexableRecord,
} from '../types'
import type { EntityId } from '@open-mercato/shared/modules/entities'

/**
 * Configuration for TokenSearchStrategy.
 */
export type TokenStrategyConfig = {
  /** Minimum number of query tokens that must match (0-1 ratio, default 0.5) */
  minMatchRatio?: number
  /** Default limit for search results */
  defaultLimit?: number
}

/**
 * TokenSearchStrategy provides hash-based search using the existing search_tokens table.
 * This strategy is always available and serves as a fallback when other strategies fail.
 *
 * It tokenizes queries into hashes and matches against pre-indexed token hashes,
 * enabling search on encrypted fields without exposing plaintext to external services.
 */
const PERSON_SEARCH_ENTITY = 'customers:customer_person_profile'
const COMPANY_SEARCH_ENTITY = 'customers:customer_company_profile'
const DEAL_SEARCH_ENTITY = 'customers:customer_deal'

export class TokenSearchStrategy implements SearchStrategy {
  readonly id: SearchStrategyId = 'tokens'
  readonly name = 'Token Search'
  readonly priority = 10 // Lowest priority, always available as fallback

  private readonly minMatchRatio: number
  private readonly defaultLimit: number

  constructor(
    private readonly knex: Knex,
    config?: TokenStrategyConfig,
  ) {
    this.minMatchRatio = config?.minMatchRatio ?? 0.5
    this.defaultLimit = config?.defaultLimit ?? 50
  }

  async isAvailable(): Promise<boolean> {
    return true // Always available
  }

  async ensureReady(): Promise<void> {
    // No initialization needed
  }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    // Dynamically import tokenization to avoid circular dependencies
    const { tokenizeText } = await import('@open-mercato/shared/lib/search/tokenize')
    const { resolveSearchConfig } = await import('@open-mercato/shared/lib/search/config')

    const config = resolveSearchConfig()
    if (!config.enabled) return []

    const limit = options.limit ?? this.defaultLimit
    const blind = await this.searchCustomerBlindIndex(query, options, limit)

    const { hashes } = tokenizeText(query, config)
    if (hashes.length === 0) return blind

    const minMatches = Math.max(1, Math.ceil(hashes.length * this.minMatchRatio))

    let queryBuilder = this.knex('search_tokens')
      .select('entity_type', 'entity_id')
      .count('* as match_count')
      .whereIn('token_hash', hashes)
      .where('tenant_id', options.tenantId)
      .groupBy('entity_type', 'entity_id')
      .havingRaw('COUNT(DISTINCT token_hash) >= ?', [minMatches])
      .orderByRaw('COUNT(DISTINCT token_hash) DESC')
      .limit(limit)

    if (options.organizationId) {
      queryBuilder = queryBuilder.where('organization_id', options.organizationId)
    }

    if (options.entityTypes?.length) {
      queryBuilder = queryBuilder.whereIn('entity_type', options.entityTypes)
    }

    const rows = await queryBuilder as Array<{ entity_type: string; entity_id: string; match_count: string | number }>

    return [...blind, ...rows.map((row) => {
      const matchCount = typeof row.match_count === 'string'
        ? parseInt(row.match_count, 10)
        : row.match_count
      // Calculate score based on match ratio
      const score = matchCount / hashes.length

      return {
        entityId: row.entity_type as EntityId,
        recordId: row.entity_id,
        score,
        source: this.id,
      }
    })]
  }

  /**
   * Contacts, companies and deals: their names, emails, phones and titles are
   * encrypted, so search_tokens no longer holds them (it held unkeyed hashes,
   * reversible by dictionary). They are matched on the keyed blind index and
   * mapped back to the search entity ids the rest of global search uses.
   */
  private async searchCustomerBlindIndex(query: string, options: SearchOptions, limit: number): Promise<SearchResult[]> {
    const wanted = options.entityTypes?.length ? new Set<string>(options.entityTypes) : null
    const types: Array<'person' | 'company' | 'deal'> = []
    if (!wanted || wanted.has(PERSON_SEARCH_ENTITY)) types.push('person')
    if (!wanted || wanted.has(COMPANY_SEARCH_ENTITY)) types.push('company')
    if (!wanted || wanted.has(DEAL_SEARCH_ENTITY)) types.push('deal')
    if (!types.length || !options.tenantId) return []
    try {
      const { resolveSearchKey } = await import('@open-mercato/shared/lib/encryption/searchKey')
      const { searchBlindIndex, searchSqlFromKnex } = await import('@open-mercato/shared/lib/encryption/searchIndex')
      const key = await resolveSearchKey(options.tenantId)
      if (!key) return []
      // Organization filter always in SQL: the caller's org, or every org of
      // the tenant when the caller is explicitly tenant-wide.
      const orgIds = options.organizationId
        ? [options.organizationId]
        : (await this.knex('organizations').where('tenant_id', options.tenantId).select('id')).map((r: { id: string }) => String(r.id))
      const { hits } = await searchBlindIndex(searchSqlFromKnex(this.knex), key, {
        tenantId: options.tenantId,
        organizationIds: orgIds,
        entityTypes: types,
        query,
        limit,
      })
      if (!hits.length) return []
      const byType = (t: string) => hits.filter((h) => h.entityType === t).map((h) => h.entityId)
      const profileIds = async (table: string, entityIds: string[]) => {
        if (!entityIds.length) return new Map<string, string>()
        const rows = await this.knex(table).whereIn('entity_id', entityIds).select('id', 'entity_id')
        return new Map<string, string>(rows.map((r: { id: string; entity_id: string }) => [String(r.entity_id), String(r.id)]))
      }
      const people = await profileIds('customer_people', byType('person'))
      const companies = await profileIds('customer_companies', byType('company'))
      const out: SearchResult[] = []
      for (const hit of hits) {
        const score = Math.min(1, 0.5 + hit.rank * 0.15)
        if (hit.entityType === 'deal') {
          out.push({ entityId: DEAL_SEARCH_ENTITY as EntityId, recordId: hit.entityId, score, source: this.id })
          continue
        }
        const map = hit.entityType === 'person' ? people : companies
        const recordId = map.get(hit.entityId)
        if (!recordId) continue
        out.push({
          entityId: (hit.entityType === 'person' ? PERSON_SEARCH_ENTITY : COMPANY_SEARCH_ENTITY) as EntityId,
          recordId,
          score,
          source: this.id,
        })
      }
      return out
    } catch {
      return []
    }
  }

  async index(record: IndexableRecord): Promise<void> {
    // Dynamically import to avoid circular dependencies
    const { replaceSearchTokensForRecord } = await import(
      '@open-mercato/core/modules/query_index/lib/search-tokens'
    )

    const { encryptedCustomFieldKeys } = await import(
      '@open-mercato/core/modules/query_index/lib/encrypted-fields'
    )
    await replaceSearchTokensForRecord(this.knex, {
      entityType: record.entityId,
      recordId: record.recordId,
      tenantId: record.tenantId,
      organizationId: record.organizationId,
      doc: record.fields,
      // record.fields is decrypted: name the encrypted custom fields explicitly
      // (the default encryption map is always excluded).
      excludeFields: await encryptedCustomFieldKeys(this.knex, record.entityId, record.tenantId),
    })
  }

  async delete(entityId: EntityId, recordId: string, tenantId: string): Promise<void> {
    // Dynamically import to avoid circular dependencies
    const { deleteSearchTokensForRecord } = await import(
      '@open-mercato/core/modules/query_index/lib/search-tokens'
    )

    await deleteSearchTokensForRecord(this.knex, {
      entityType: entityId,
      recordId,
      tenantId,
    })
  }

  async bulkIndex(records: IndexableRecord[]): Promise<void> {
    if (records.length === 0) return

    const { replaceSearchTokensForBatch } = await import(
      '@open-mercato/core/modules/query_index/lib/search-tokens'
    )

    const { encryptedCustomFieldKeys } = await import(
      '@open-mercato/core/modules/query_index/lib/encrypted-fields'
    )
    const payloads = await Promise.all(records.map(async (record) => ({
      entityType: record.entityId,
      recordId: record.recordId,
      tenantId: record.tenantId,
      organizationId: record.organizationId,
      doc: record.fields as Record<string, unknown>,
      excludeFields: await encryptedCustomFieldKeys(this.knex, record.entityId, record.tenantId),
    })))

    await replaceSearchTokensForBatch(this.knex, payloads)
  }

  async purge(entityId: EntityId, tenantId: string): Promise<void> {
    await this.knex('search_tokens')
      .where({ entity_type: entityId, tenant_id: tenantId })
      .del()
  }
}
