import {
  canonicalOperator,
  conditionContext,
  conditionsNeedContact,
  evaluateCondition,
  evaluateConditions,
  parseConditions,
  resolveConditionValue,
} from '../automation-conditions'

// The Automations builder's operator list (customers/backend/automations-v2/page.tsx).
const BUILDER_OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'is_set', 'is_not_set']

const contact = {
  contactId: 'c-1',
  source: 'website',
  lifecycle_stage: 'customer',
  primary_email: 'dana@example.com',
  display_name: 'Dana Buyer',
  tags: ['vip-client', 'VIP Client'],
}

describe('automation conditions', () => {
  it('knows every operator the builder saves', () => {
    for (const op of BUILDER_OPERATORS) expect(canonicalOperator(op)).not.toBeNull()
  })

  it('evaluates each builder operator for real (they all used to pass)', () => {
    const check = (field: string, operator: string, value?: unknown) => evaluateCondition({ field, operator, value }, contact).passes
    expect(check('lifecycle_stage', 'equals', 'customer')).toBe(true)
    expect(check('lifecycle_stage', 'equals', 'prospect')).toBe(false)
    expect(check('lifecycle_stage', 'equals', 'Customer')).toBe(true)
    expect(check('source', 'not_equals', 'website')).toBe(false)
    expect(check('source', 'not_equals', 'referral')).toBe(true)
    expect(check('primary_email', 'contains', 'EXAMPLE.com')).toBe(true)
    expect(check('primary_email', 'not_contains', 'example.com')).toBe(false)
    expect(check('display_name', 'starts_with', 'dana')).toBe(true)
    expect(check('display_name', 'starts_with', 'Buyer')).toBe(false)
    expect(check('primary_email', 'is_set')).toBe(true)
    expect(check('primary_email', 'is_not_set')).toBe(false)
    expect(check('primary_phone', 'is_set')).toBe(false)
    expect(check('primary_phone', 'is_not_set')).toBe(true)
  })

  it('a rule limited to customers is skipped for a prospect, with a readable reason', () => {
    const out = evaluateConditions([{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }], { ...contact, lifecycle_stage: 'prospect' })
    expect(out.pass).toBe(false)
    expect(out.reason).toBe('lifecycle_stage equals customer failed (got: prospect)')
  })

  it('an unknown operator fails closed and says why', () => {
    const out = evaluateConditions([{ field: 'source', operator: 'sounds_like', value: 'web' }], contact)
    expect(out.pass).toBe(false)
    expect(out.results[0]!.error).toBe('Unknown condition operator "sounds_like"')
    expect(out.reason).toBe('Unknown condition operator "sounds_like"')
  })

  it('unreadable saved conditions fail closed', () => {
    expect(evaluateConditions('{not json', contact).pass).toBe(false)
    expect(evaluateConditions({ field: 'source' }, contact).pass).toBe(false)
  })

  it('a row saved with no value is not applied, and says so (it never was; failing it now would stop the rule)', () => {
    const out = evaluateConditions([{ field: 'source', operator: 'equals', value: '' }], contact)
    expect(out.pass).toBe(true)
    expect(out.results[0]!.note).toBe('No value set, so this condition is ignored')
    // is_set / is_not_set need no value and still apply.
    expect(evaluateConditions([{ field: 'primary_phone', operator: 'is_set' }], contact).pass).toBe(false)
  })

  it('no conditions pass', () => {
    expect(evaluateConditions(null, contact).pass).toBe(true)
    expect(evaluateConditions('[]', contact).pass).toBe(true)
    expect(evaluateConditions('', contact).pass).toBe(true)
  })

  it('speaks the templates’ short dialect too', () => {
    const ctx = { stage: 'won', value: '12000', type: 'link_click', status: 'sent', due_date: '2026-09-01T00:00:00Z' }
    const now = new Date('2026-09-25T12:00:00Z')
    expect(evaluateConditions([{ field: 'stage', operator: 'eq', value: 'won' }], ctx).pass).toBe(true)
    expect(evaluateConditions([{ field: 'value', operator: 'gte', value: 10000 }], ctx).pass).toBe(true)
    expect(evaluateConditions([{ field: 'value', operator: 'lt', value: 10000 }], ctx).pass).toBe(false)
    expect(evaluateConditions([{ field: 'type', operator: 'in', value: ['email_open', 'link_click'] }], ctx).pass).toBe(true)
    expect(evaluateConditions([{ field: 'status', operator: 'neq', value: 'completed' }], ctx).pass).toBe(true)
    expect(evaluateConditions([{ field: 'due_date', operator: 'lt', value: '{{now}}' }], ctx, now).pass).toBe(true)
    expect(evaluateConditions([{ field: 'due_date', operator: 'lt', value: '{{now-30d}}' }], ctx, now).pass).toBe(false)
    expect(evaluateConditions([{ field: 'primary_email', operator: 'exists' }], contact).pass).toBe(true)
    expect(evaluateConditions([{ field: 'primary_phone', operator: 'notExists' }], contact).pass).toBe(true)
  })

  it('"tags contains" is list membership, not a substring', () => {
    expect(evaluateCondition({ field: 'tags', operator: 'contains', value: 'vip-client' }, contact).passes).toBe(true)
    expect(evaluateCondition({ field: 'tags', operator: 'contains', value: 'vip client' }, contact).passes).toBe(true)
    expect(evaluateCondition({ field: 'tags', operator: 'contains', value: 'vip' }, contact).passes).toBe(false)
    expect(evaluateCondition({ field: 'tags', operator: 'not_contains', value: 'enrolled' }, contact).passes).toBe(true)
  })

  it('compares numbers that were typed as text', () => {
    expect(evaluateCondition({ field: 'amount', operator: 'gt', value: '999' }, { amount: 1250000 }).passes).toBe(true)
    expect(evaluateCondition({ field: 'amount', operator: 'gt', value: 'lots' }, { amount: 1250000 }).passes).toBe(false)
  })

  it('resolves template date placeholders', () => {
    const now = new Date('2026-09-25T12:00:00Z')
    expect(resolveConditionValue('{{now-14d}}', now)).toEqual(new Date('2026-09-11T12:00:00Z'))
    expect(resolveConditionValue('{{now+24h}}', now)).toEqual(new Date('2026-09-26T12:00:00Z'))
    expect(resolveConditionValue('customer', now)).toBe('customer')
  })

  it('the trigger’s own data wins over the contact’s, and fills only what the trigger lacks', () => {
    const merged = conditionContext({ contactId: 'c-1', stage: 'won', source: undefined, status: 'open' }, { source: 'manual', lifecycle_stage: 'lead', status: 'active' })
    expect(merged).toMatchObject({ stage: 'won', source: 'manual', lifecycle_stage: 'lead', status: 'open' })
  })

  it('knows when the contact has to be loaded', () => {
    const conditions = parseConditions(JSON.stringify([{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }]))
    expect(conditionsNeedContact(conditions, { contactId: 'c-1', tagSlug: 'vip' })).toBe(true)
    expect(conditionsNeedContact(conditions, { contactId: 'c-1', lifecycle_stage: 'customer' })).toBe(false)
  })
})
