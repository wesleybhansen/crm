import { Migration } from '@mikro-orm/migrations'
/* Inlined from ../lib/dealDefaultsData.ts: migrations must be self-contained (the runner image cannot import lib files). */
/**
 * Plain data behind a workspace's deal defaults: the deal statuses, the
 * default pipeline's stages and the currency list. No ORM or app imports, so
 * the backfill migration, the seeding helper (dealDefaults.ts) and the CLI
 * seeders all share one copy.
 */

type DealDictionaryDefault = {
  value: string
  label: string
  color?: string
  icon?: string
}

/** Deal status dictionary (kind `deal_status`). Values are stored on deals, so they never change; labels may. */
const DEAL_STATUS_DEFAULTS: DealDictionaryDefault[] = [
  { value: 'open', label: 'Open', color: '#2563eb', icon: 'lucide:circle' },
  { value: 'closed', label: 'Closed', color: '#6b7280', icon: 'lucide:check-circle' },
  { value: 'win', label: 'Won', color: '#22c55e', icon: 'lucide:trophy' },
  { value: 'loose', label: 'Lost', color: '#ef4444', icon: 'lucide:flag' },
  { value: 'in_progress', label: 'In progress', color: '#f59e0b', icon: 'lucide:activity' },
]

/** Stages of the default pipeline, in board order (also the `pipeline_stage` dictionary). */
const PIPELINE_STAGE_DEFAULTS: DealDictionaryDefault[] = [
  { value: 'opportunity', label: 'Opportunity', color: '#38bdf8', icon: 'lucide:target' },
  { value: 'marketing_qualified_lead', label: 'Marketing Qualified Lead', color: '#a855f7', icon: 'lucide:sparkles' },
  { value: 'sales_qualified_lead', label: 'Sales Qualified Lead', color: '#f97316', icon: 'lucide:users' },
  { value: 'offering', label: 'Offering', color: '#22c55e', icon: 'lucide:package' },
  { value: 'negotiations', label: 'Negotiations', color: '#facc15', icon: 'lucide:handshake' },
  { value: 'win', label: 'Won', color: '#16a34a', icon: 'lucide:award' },
  { value: 'loose', label: 'Lost', color: '#ef4444', icon: 'lucide:flag' },
]

const DEFAULT_PIPELINE_NAME = 'Default Pipeline'

/** Key of the shared `dictionaries` row the deal form reads currencies from. */
const CURRENCY_DICTIONARY_KEY = 'currency'

const PRIORITY_CURRENCIES = ['EUR', 'USD', 'GBP', 'PLN']

/** Priority currencies first, then every ISO 4217 code the runtime knows, alphabetically. */
function resolveCurrencyCodes(): string[] {
  const normalizedPriority = PRIORITY_CURRENCIES.map((code) => code.toUpperCase())
  const intlWithSupportedValues = Intl as typeof Intl & {
    supportedValuesOf?: (input: 'currency') => string[]
  }
  const supported: string[] =
    typeof intlWithSupportedValues.supportedValuesOf === 'function'
      ? intlWithSupportedValues.supportedValuesOf('currency')
      : []
  const uniqueSupported: string[] = []
  const seen = new Set<string>(normalizedPriority)
  for (const raw of supported) {
    const code = raw.toUpperCase()
    if (!/^[A-Z]{3}$/.test(code) || seen.has(code)) continue
    seen.add(code)
    uniqueSupported.push(code)
  }
  uniqueSupported.sort((a, b) => a.localeCompare(b))
  return [...normalizedPriority, ...uniqueSupported]
}

let currencyDisplayNames: { of(value: string): string | undefined } | null | undefined

/** "USD – US Dollar", or the bare code when the runtime has no display names. */
function resolveCurrencyLabel(code: string): string {
  try {
    if (currencyDisplayNames === undefined) {
      const intlWithDisplayNames = Intl as typeof Intl & {
        DisplayNames?: new (locales: string[], options: { type: 'currency' }) => {
          of(value: string): string | undefined
        }
      }
      currencyDisplayNames =
        typeof intlWithDisplayNames.DisplayNames === 'function'
          ? new intlWithDisplayNames.DisplayNames(['en'], { type: 'currency' })
          : null
    }
    const label = currencyDisplayNames?.of(code)
    if (typeof label === 'string' && label.trim().length) return `${code} – ${label}`
  } catch {
    // fall through to the bare code
  }
  return code
}


/* Deal defaults backfill (2026-09-25).
 *
 * Workspaces auto-provisioned at sign-in never ran the customers module's
 * seedDefaults, so they had no pipeline, no stages, no deal statuses and no
 * currency dictionary: the deal form could not create a deal ("Invalid UUID"
 * under Pipeline) and GET /api/customers/dictionaries/currency returned 404.
 *
 * For every non-deleted organization this adds, only where missing:
 *   - a "Default Pipeline" (orgs with no pipeline at all),
 *   - the default stages on each default pipeline that has no stages,
 *   - the deal status dictionary entries (kind deal_status),
 *   - the "currency" dictionary and its ISO 4217 entries.
 * None of these columns are in DEFAULT_ENCRYPTION_MAPS, so plain SQL is safe.
 * Idempotent (NOT EXISTS / ON CONFLICT DO NOTHING); down() is a no-op because
 * rows may have been edited or used by deals since. New organizations get the
 * same defaults from ensureCustomerDealDefaults (lib/dealDefaults.ts). */

function literal(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'null'
  return `'${value.replace(/'/g, "''")}'`
}

/* The dictionaries module's tables are created by that module's own
 * migrations, which run after this one on a brand-new database (where there
 * are no organizations to backfill anyway). Skip those statements when the
 * table isn't there yet instead of failing the whole migrate run. */
function whenTableExists(table: string, sql: string): string {
  return `DO $do$
BEGIN
  IF to_regclass('public.${table}') IS NOT NULL THEN
    EXECUTE $sql$${sql}$sql$;
  END IF;
END $do$;`
}

export class Migration20260925153000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      insert into "customer_pipelines" ("organization_id", "tenant_id", "name", "is_default", "created_at", "updated_at")
      select o."id", o."tenant_id", ${literal(DEFAULT_PIPELINE_NAME)}, true, now(), now()
      from "organizations" o
      where o."deleted_at" is null
        and not exists (
          select 1 from "customer_pipelines" p
          where p."organization_id" = o."id" and p."tenant_id" = o."tenant_id"
        );
    `)

    const stageRows = PIPELINE_STAGE_DEFAULTS
      .map((stage, index) => `(${literal(stage.label)}, ${index})`)
      .join(', ')
    this.addSql(`
      insert into "customer_pipeline_stages" ("organization_id", "tenant_id", "pipeline_id", "name", "position", "created_at", "updated_at")
      select p."organization_id", p."tenant_id", p."id", s.label, s.position, now(), now()
      from "customer_pipelines" p
      join "organizations" o on o."id" = p."organization_id" and o."deleted_at" is null
      cross join (values ${stageRows}) as s(label, position)
      where p."is_default" = true
        and not exists (
          select 1 from "customer_pipeline_stages" st where st."pipeline_id" = p."id"
        );
    `)

    const statusRows = DEAL_STATUS_DEFAULTS
      .map((entry) => `(${literal(entry.value)}, ${literal(entry.value.toLowerCase())}, ${literal(entry.label)}, ${literal(entry.color)}, ${literal(entry.icon)})`)
      .join(', ')
    this.addSql(`
      insert into "customer_dictionary_entries" ("organization_id", "tenant_id", "kind", "value", "normalized_value", "label", "color", "icon", "created_at", "updated_at")
      select o."id", o."tenant_id", 'deal_status', v.value, v.normalized_value, v.label, v.color, v.icon, now(), now()
      from "organizations" o
      cross join (values ${statusRows}) as v(value, normalized_value, label, color, icon)
      where o."deleted_at" is null
      on conflict ("organization_id", "tenant_id", "kind", "normalized_value") do nothing;
    `)

    this.addSql(whenTableExists('dictionaries', `
      insert into "dictionaries" ("organization_id", "tenant_id", "key", "name", "description", "is_system", "is_active", "manager_visibility", "created_at", "updated_at")
      select o."id", o."tenant_id", ${literal(CURRENCY_DICTIONARY_KEY)}, 'Currencies', 'ISO 4217 currencies', true, true, 'default', now(), now()
      from "organizations" o
      where o."deleted_at" is null
      on conflict ("organization_id", "tenant_id", "key") do nothing
    `))

    const currencyRows = resolveCurrencyCodes()
      .map((code) => `(${literal(code)}, ${literal(code.toLowerCase())}, ${literal(resolveCurrencyLabel(code))})`)
      .join(', ')
    this.addSql(whenTableExists('dictionary_entries', `
      insert into "dictionary_entries" ("dictionary_id", "organization_id", "tenant_id", "value", "normalized_value", "label", "created_at", "updated_at")
      select d."id", d."organization_id", d."tenant_id", c.value, c.normalized_value, c.label, now(), now()
      from "dictionaries" d
      join "organizations" o on o."id" = d."organization_id" and o."deleted_at" is null
      cross join (values ${currencyRows}) as c(value, normalized_value, label)
      where d."key" = ${literal(CURRENCY_DICTIONARY_KEY)} and d."deleted_at" is null
        and not exists (
          select 1 from "dictionary_entries" e where e."dictionary_id" = d."id"
        )
      on conflict ("dictionary_id", "organization_id", "tenant_id", "normalized_value") do nothing
    `))
  }

  override async down(): Promise<void> {
    // Seeded rows may be in use by deals; nothing to undo safely.
  }
}
