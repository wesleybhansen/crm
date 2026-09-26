/**
 * Automation rule conditions ("Only if..." in the Automations builder).
 *
 * The builder saves equals / not_equals / contains / not_contains /
 * starts_with / is_set / is_not_set; the runner only knew eq / neq / gt / gte /
 * lt / lte / contains / exists / notExists and let every other operator pass.
 * So six of the builder's seven operators were ignored, and a rule limited to
 * "Lifecycle Stage equals customer" ran for everyone. The installed templates
 * speak the short dialect (eq, exists, in, gte, dates like {{now-14d}}).
 *
 * One evaluator for both dialects, used by the runner and by the Test panel.
 * An operator it does not know FAILS the condition (the rule is skipped and the
 * reason is logged in its run history) instead of passing silently.
 *
 * Pure, no imports: the dispatch subscribers bundle this into the queue workers.
 */

export type AutomationCondition = { field: string; operator: string; value?: unknown }

export type CanonicalOperator =
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'starts_with' | 'ends_with'
  | 'is_set' | 'is_not_set'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in'

export type ConditionResult = {
  field: string
  operator: string
  value: unknown
  actual: unknown
  passes: boolean
  error?: string
  /** Set when the condition was not applied (an incomplete row with no value). */
  note?: string
}

export type ConditionsOutcome = { pass: boolean; reason?: string; results: ConditionResult[] }

const OPERATORS: Record<string, CanonicalOperator> = {
  equals: 'equals', eq: 'equals', is: 'equals', '=': 'equals', '==': 'equals',
  not_equals: 'not_equals', neq: 'not_equals', ne: 'not_equals', is_not: 'not_equals', '!=': 'not_equals', '<>': 'not_equals',
  contains: 'contains', includes: 'contains', has: 'contains',
  not_contains: 'not_contains', notcontains: 'not_contains', does_not_contain: 'not_contains', not_has: 'not_contains',
  starts_with: 'starts_with', startswith: 'starts_with',
  ends_with: 'ends_with', endswith: 'ends_with',
  is_set: 'is_set', exists: 'is_set', is_not_empty: 'is_set', not_empty: 'is_set', present: 'is_set',
  is_not_set: 'is_not_set', notexists: 'is_not_set', not_exists: 'is_not_set', is_empty: 'is_not_set', empty: 'is_not_set', missing: 'is_not_set',
  gt: 'gt', '>': 'gt', greater_than: 'gt',
  gte: 'gte', '>=': 'gte',
  lt: 'lt', '<': 'lt', less_than: 'lt',
  lte: 'lte', '<=': 'lte',
  in: 'in', one_of: 'in', is_one_of: 'in',
  not_in: 'not_in', notin: 'not_in', not_one_of: 'not_in',
}

/** The canonical operator for any spelling the builder, templates or AI save; null when unknown. */
export function canonicalOperator(operator: unknown): CanonicalOperator | null {
  if (typeof operator !== 'string') return null
  const key = operator.trim()
  return OPERATORS[key] ?? OPERATORS[key.toLowerCase()] ?? null
}

/** Parse the rule's `conditions` column (jsonb, or a JSON string from older writers). */
export function parseConditions(raw: unknown): AutomationCondition[] {
  let value = raw
  if (typeof value === 'string') {
    if (!value.trim()) return []
    try {
      value = JSON.parse(value)
    } catch {
      return [{ field: '', operator: '__invalid__', value: raw }]
    }
  }
  if (value == null) return []
  if (!Array.isArray(value)) return [{ field: '', operator: '__invalid__', value }]
  return value.map((c) => {
    const item = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
    return { field: typeof item.field === 'string' ? item.field : '', operator: typeof item.operator === 'string' ? item.operator : '', value: item.value }
  })
}

function readPath(ctx: Record<string, unknown>, path: string): unknown {
  if (path in ctx) return ctx[path]
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ctx)
}

function isEmpty(value: unknown): boolean {
  if (value == null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

function str(value: unknown): string {
  if (value instanceof Date) return value.toISOString().toLowerCase()
  return String(value).trim().toLowerCase()
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(value.trim())) {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asTime(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'string' && /\d{4}-\d{2}-\d{2}/.test(value)) {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** Template date placeholders: {{now}}, {{now-14d}}, {{now+3d}}, {{now-24h}}. Anything else is returned as is. */
export function resolveConditionValue(value: unknown, now: Date = new Date()): unknown {
  if (typeof value !== 'string') return value
  const m = /^\{\{\s*now\s*(?:([+-])\s*(\d+)\s*([mhdw]))?\s*\}\}$/i.exec(value.trim())
  if (!m) return value
  if (!m[1]) return new Date(now.getTime())
  const delta = Number(m[2]) * UNIT_MS[m[3]!.toLowerCase()]!
  return new Date(now.getTime() + (m[1] === '-' ? -delta : delta))
}

function equalsOne(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((item) => equalsOne(item, expected))
  if (isEmpty(expected)) return isEmpty(actual)
  if (isEmpty(actual)) return false
  const an = asNumber(actual)
  const en = asNumber(expected)
  if (an != null && en != null) return an === en
  const at = asTime(actual)
  const et = asTime(expected)
  if (at != null && et != null) return at === et
  return str(actual) === str(expected)
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (isEmpty(actual)) return false
  // A list (tags) contains an item: membership, not substring, so "enrolled"
  // does not match "not-enrolled".
  if (Array.isArray(actual)) return actual.some((item) => equalsOne(item, expected))
  if (isEmpty(expected)) return true
  return str(actual).includes(str(expected))
}

function listOf(expected: unknown): unknown[] {
  if (Array.isArray(expected)) return expected
  if (typeof expected === 'string') return expected.split(',').map((s) => s.trim()).filter(Boolean)
  return expected == null ? [] : [expected]
}

function ordered(actual: unknown, expected: unknown): number | null {
  const an = asNumber(actual)
  const en = asNumber(expected)
  if (an != null && en != null) return an - en
  const at = asTime(actual)
  const et = asTime(expected)
  if (at != null && et != null) return at - et
  return null
}

/** Evaluate one condition against the trigger context (plus the contact's fields). */
export function evaluateCondition(
  condition: AutomationCondition,
  ctx: Record<string, unknown>,
  now: Date = new Date(),
): ConditionResult {
  const base = { field: condition.field, operator: condition.operator, value: condition.value }
  if (condition.operator === '__invalid__') {
    return { ...base, actual: undefined, passes: false, error: 'The saved conditions could not be read' }
  }
  const op = canonicalOperator(condition.operator)
  if (!op) {
    return { ...base, actual: undefined, passes: false, error: `Unknown condition operator "${condition.operator || '(none)'}"` }
  }
  if (!condition.field || typeof condition.field !== 'string') {
    return { ...base, actual: undefined, passes: false, error: 'Condition has no field' }
  }
  const actual = readPath(ctx, condition.field)
  // A row saved with no value ("Source equals" and a blank box) is not a
  // filter. It was never applied before, and failing it now would quietly
  // stop the automation; the builder no longer saves such rows.
  if (op !== 'is_set' && op !== 'is_not_set' && isEmpty(condition.value)) {
    return { ...base, actual, passes: true, note: 'No value set, so this condition is ignored' }
  }
  const expected = resolveConditionValue(condition.value, now)
  let passes: boolean
  switch (op) {
    case 'equals': passes = equalsOne(actual, expected); break
    case 'not_equals': passes = !equalsOne(actual, expected); break
    case 'contains': passes = containsValue(actual, expected); break
    case 'not_contains': passes = !containsValue(actual, expected); break
    case 'starts_with': passes = !isEmpty(actual) && !Array.isArray(actual) && str(actual).startsWith(str(expected ?? '')); break
    case 'ends_with': passes = !isEmpty(actual) && !Array.isArray(actual) && str(actual).endsWith(str(expected ?? '')); break
    case 'is_set': passes = !isEmpty(actual); break
    case 'is_not_set': passes = isEmpty(actual); break
    case 'in': passes = listOf(expected).some((item) => equalsOne(actual, item)); break
    case 'not_in': passes = !listOf(expected).some((item) => equalsOne(actual, item)); break
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const diff = ordered(actual, expected)
      if (diff == null) {
        passes = false
        break
      }
      passes = op === 'gt' ? diff > 0 : op === 'gte' ? diff >= 0 : op === 'lt' ? diff < 0 : diff <= 0
      break
    }
  }
  return { ...base, actual, passes }
}

function display(value: unknown): string {
  if (value == null || value === '') return 'empty'
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : 'empty'
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/** Every condition must pass. The reason names the first one that did not. */
export function evaluateConditions(
  conditions: unknown,
  ctx: Record<string, unknown>,
  now: Date = new Date(),
): ConditionsOutcome {
  const results = parseConditions(conditions).map((c) => evaluateCondition(c, ctx, now))
  const failed = results.find((r) => !r.passes)
  if (!failed) return { pass: true, results }
  const reason = failed.error
    ?? `${failed.field} ${failed.operator}${failed.value != null && failed.value !== '' ? ` ${display(failed.value)}` : ''} failed (got: ${display(failed.actual)})`
  return { pass: false, reason, results }
}

/**
 * True when a condition reads a field the trigger context does not carry, so
 * the runner has to load the contact's fields before evaluating.
 */
export function conditionsNeedContact(conditions: AutomationCondition[], context: Record<string, unknown>): boolean {
  return conditions.some((c) => {
    if (!c.field) return false
    const value = readPath(context, c.field)
    return isEmpty(value)
  })
}

/**
 * The context a rule's conditions read: the trigger's own data wins, the
 * contact's fields fill what the trigger did not carry (so "Lifecycle Stage"
 * and "Email" work on every trigger, not only on the ones that happened to
 * copy them into the event).
 */
export function conditionContext(
  context: Record<string, unknown>,
  contactFacts: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(contactFacts ?? {}) }
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null && !(typeof value === 'string' && value === '')) out[key] = value
    else if (!(key in out)) out[key] = value
  }
  return out
}
