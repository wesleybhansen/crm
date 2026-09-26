/**
 * Plain data behind a workspace's deal defaults: the deal statuses, the
 * default pipeline's stages and the currency list. No ORM or app imports, so
 * the backfill migration, the seeding helper (dealDefaults.ts) and the CLI
 * seeders all share one copy.
 */

export type DealDictionaryDefault = {
  value: string
  label: string
  color?: string
  icon?: string
}

/**
 * Deal status dictionary (kind `deal_status`). Values are stored on deals, so
 * they do not change lightly; labels may. Lost was stored as 'loose' until
 * 2026-09-29 (Migration20260929120000 renamed the entries and the deals).
 */
export const DEAL_STATUS_DEFAULTS: DealDictionaryDefault[] = [
  { value: 'open', label: 'Open', color: '#2563eb', icon: 'lucide:circle' },
  { value: 'closed', label: 'Closed', color: '#6b7280', icon: 'lucide:check-circle' },
  { value: 'win', label: 'Won', color: '#22c55e', icon: 'lucide:trophy' },
  { value: 'lost', label: 'Lost', color: '#ef4444', icon: 'lucide:flag' },
  { value: 'in_progress', label: 'In progress', color: '#f59e0b', icon: 'lucide:activity' },
]

/** Stages of the default pipeline, in board order (also the `pipeline_stage` dictionary). */
export const PIPELINE_STAGE_DEFAULTS: DealDictionaryDefault[] = [
  { value: 'opportunity', label: 'Opportunity', color: '#38bdf8', icon: 'lucide:target' },
  { value: 'marketing_qualified_lead', label: 'Marketing Qualified Lead', color: '#a855f7', icon: 'lucide:sparkles' },
  { value: 'sales_qualified_lead', label: 'Sales Qualified Lead', color: '#f97316', icon: 'lucide:users' },
  { value: 'offering', label: 'Offering', color: '#22c55e', icon: 'lucide:package' },
  { value: 'negotiations', label: 'Negotiations', color: '#facc15', icon: 'lucide:handshake' },
  { value: 'win', label: 'Won', color: '#16a34a', icon: 'lucide:award' },
  { value: 'loose', label: 'Lost', color: '#ef4444', icon: 'lucide:flag' },
]

export const DEFAULT_PIPELINE_NAME = 'Default Pipeline'

/** Key of the shared `dictionaries` row the deal form reads currencies from. */
export const CURRENCY_DICTIONARY_KEY = 'currency'

export const PRIORITY_CURRENCIES = ['EUR', 'USD', 'GBP', 'PLN']

/** Priority currencies first, then every ISO 4217 code the runtime knows, alphabetically. */
export function resolveCurrencyCodes(): string[] {
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
export function resolveCurrencyLabel(code: string): string {
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
