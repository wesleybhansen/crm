import { Migration } from '@mikro-orm/migrations';
import { SEARCH_INDEX_DOWN_SQL, SEARCH_INDEX_SCHEMA_SQL, searchIndexPurgeSql } from '../lib/searchIndexSchema';

/* Blind search index for encrypted contact, company and deal fields
 * (2026-09-25).
 *
 * customer_search_tokens holds HMAC-SHA256 hashes of normalized name / email /
 * phone / title tokens under a per-tenant key derived from the tenant data key
 * (packages/shared/src/lib/encryption/searchTokens.ts). Search matches hashes
 * in SQL instead of decrypting an organization's latest 2,000 contacts.
 * Indexes: (tenant_id, organization_id, token_hash) for lookups, and a unique
 * (entity_id, entity_type, field, token_hash) that makes inserts idempotent and
 * serves per-entity replace/delete. Triggers drop an entity's tokens on any
 * hard delete or soft delete, whatever path deletes it.
 *
 * Also purges plaintext-equivalent copies of encrypted fields that the Open
 * Mercato query index and search module wrote (unkeyed SHA-256 search_tokens,
 * the search_text aggregate, vector_search display text); see
 * searchIndexPurgeSql. The tokens themselves are filled by
 * scripts/reindex-customer-search.ts (needs the tenant key, so not SQL).
 *
 * Idempotent; production applies it with
 * `node /app/scripts/reindex-customer-search.cjs --apply-migration --execute`
 * because the runner image cannot run the migrator. */
export class Migration20260925120000 extends Migration {

  override async up(): Promise<void> {
    for (const sql of SEARCH_INDEX_SCHEMA_SQL) this.addSql(sql);
    for (const sql of searchIndexPurgeSql()) this.addSql(sql);
  }

  override async down(): Promise<void> {
    // The purge is not reversible (and must not be: it removed plaintext copies).
    for (const sql of SEARCH_INDEX_DOWN_SQL) this.addSql(sql);
  }

}
