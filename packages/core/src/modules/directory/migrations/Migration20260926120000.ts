import { Migration } from '@mikro-orm/migrations';
import { TENANT_SPLIT_SCHEMA_DOWN_SQL, TENANT_SPLIT_SCHEMA_SQL } from '../lib/tenantSplitSchema';

/**
 * One tenant per customer: tenants.seed_version and organization_tenant_moves.
 * See lib/tenantSplitSchema.ts. Idempotent: the production box applies it with
 * `mercato db migrate`.
 */
export class Migration20260926120000 extends Migration {

  override async up(): Promise<void> {
    for (const sql of TENANT_SPLIT_SCHEMA_SQL) this.addSql(sql);
  }

  override async down(): Promise<void> {
    for (const sql of TENANT_SPLIT_SCHEMA_DOWN_SQL) this.addSql(sql);
  }

}
