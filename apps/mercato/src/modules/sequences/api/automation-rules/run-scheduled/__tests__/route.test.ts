const mockSession = { current: null as null | { orgId: string; tenantId: string } }
const mockDb: { knex: unknown } = { knex: null }

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: jest.fn(async () => mockSession.current),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({ resolve: () => ({ getKnex: () => mockDb.knex }) })),
}))
jest.mock('@/modules/email/lib/email-router', () => ({
  sendEmailByPurpose: jest.fn(async () => ({ ok: false, error: 'email is not sent in tests' })),
  sendEmailForOrg: jest.fn(async () => ({ ok: false, error: 'email is not sent in tests' })),
}))

import { createFakeDb } from '../../../../../../lib/__tests__/support/fake-db'
import * as automationExecute from '@/modules/sequences/lib/automation-execute'
import { POST, metadata, runScheduledRulesForOrg, scheduleTargetIds } from '../route'

const SECRET = 'cron-secret-for-tests'

function rule(id: string, organizationId: string, tenantId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Daily follow-up ${id}`,
    organization_id: organizationId,
    tenant_id: tenantId,
    trigger_type: 'schedule',
    trigger_config: JSON.stringify({ scheduleType: 'daily_summary', intervalMinutes: 1440 }),
    action_type: 'create_task',
    action_config: JSON.stringify({ taskTitle: 'Review {{reference}}' }),
    steps: null,
    is_active: true,
    ...overrides,
  }
}

function world() {
  const knex = createFakeDb({
    automation_rules: [
      rule('r-a', 'org-a', 'tenant-a'),
      rule('r-b', 'org-b', 'tenant-b'),
      rule('r-off', 'org-b', 'tenant-b', { is_active: false }),
      rule('r-other-trigger', 'org-a', 'tenant-a', { trigger_type: 'deal_won' }),
    ],
    automation_rule_logs: [],
    automation_scheduled_steps: [],
    tasks: [],
  })
  mockDb.knex = knex
  return knex
}

function call(body: Record<string, unknown> = {}, token?: string) {
  return POST(new Request('http://crm.test/api/sequences/automation-rules/run-scheduled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  process.env.SEQUENCE_PROCESS_SECRET = SECRET
  mockSession.current = null
})

describe('run-scheduled route', () => {
  it('checks auth in the handler (session or the cron token), never publicly', async () => {
    expect(metadata.POST.requireAuth).toBe(false)
    world()
    expect((await call()).status).toBe(401)
    expect((await call({}, 'wrong-token')).status).toBe(401)
    expect((await call({}, `${SECRET}x`)).status).toBe(401)
  })

  it('the cron token runs every tenant’s due rules, each in its own scope, once per interval', async () => {
    const knex = world()
    const res = await call({}, SECRET)
    expect(res.status).toBe(200)
    const tasks = knex.db.tables.tasks
    expect(tasks.map((t: Record<string, unknown>) => [t.organization_id, t.tenant_id]).sort()).toEqual([
      ['org-a', 'tenant-a'],
      ['org-b', 'tenant-b'],
    ])
    expect(knex.db.tables.automation_rule_logs).toHaveLength(2)
    // The daily-summary placeholder is not a contact (it hit a uuid column in production).
    expect(tasks.every((t: Record<string, unknown>) => t.contact_id === null)).toBe(true)
    expect(knex.db.tables.automation_rule_logs.every((l: Record<string, unknown>) => l.contact_id === null)).toBe(true)
    const body = await res.json()
    expect(body.data.organizations).toHaveLength(2)
    expect(body.data.delayedSteps).toMatchObject({ processed: 0 })

    await call({}, SECRET)
    expect(knex.db.tables.tasks).toHaveLength(2)
  })

  it('a dry run reports what is due without running or moving lastRun', async () => {
    const knex = world()
    const res = await call({ dryRun: true }, SECRET)
    const body = await res.json()
    expect(body.data.dryRun).toBe(true)
    expect(body.data.organizations.flatMap((o: { results: unknown[] }) => o.results)).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: 'r-a', targetsFound: 1, executed: 0, skipped: false })]),
    )
    expect(knex.db.tables.tasks).toHaveLength(0)
    expect(knex.db.tables.automation_rule_logs).toHaveLength(0)
    expect(JSON.parse(String(knex.db.tables.automation_rules[0].trigger_config)).lastRun).toBeUndefined()
  })

  it('can be limited to one organization for a check', async () => {
    const knex = world()
    await call({ organizationId: 'org-b' }, SECRET)
    expect(knex.db.tables.tasks.map((t: Record<string, unknown>) => t.organization_id)).toEqual(['org-b'])
  })

  it('a signed-in user runs only their own organization', async () => {
    const knex = world()
    mockSession.current = { orgId: 'org-a', tenantId: 'tenant-a' }
    const res = await call({})
    expect(res.status).toBe(200)
    expect(knex.db.tables.tasks.map((t: Record<string, unknown>) => t.organization_id)).toEqual(['org-a'])
  })

  it('two runs arriving together execute a rule once (the page load and the cron)', async () => {
    const knex = world()
    const scope = { organizationId: 'org-a', tenantId: 'tenant-a' }
    const [first, second] = await Promise.all([
      runScheduledRulesForOrg(knex, scope),
      runScheduledRulesForOrg(knex, scope),
    ])
    expect(knex.db.tables.tasks).toHaveLength(1)
    expect([first.results[0]!.skipped, second.results[0]!.skipped].sort()).toEqual([false, true])
  })

  it('a failing delayed-step pass never fails the scheduled run', async () => {
    const knex = world()
    const spy = jest.spyOn(automationExecute, 'processScheduledSteps').mockRejectedValueOnce(new Error('relation "automation_scheduled_steps" does not exist'))
    const res = await call({}, SECRET)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.delayedSteps.error).toMatch(/does not exist/)
    expect(knex.db.tables.tasks).toHaveLength(2)
    spy.mockRestore()
  })

  it('maps each scheduled target to its real records', () => {
    expect(scheduleTargetIds('inactive_contacts', { id: 'c-1' })).toEqual({ contactId: 'c-1' })
    expect(scheduleTargetIds('invoice_overdue', { id: 'inv-1', contact_id: 'c-2' })).toEqual({ contactId: 'c-2', invoiceId: 'inv-1' })
    expect(scheduleTargetIds('stale_deals', { id: 'deal-1' })).toEqual({ contactId: null, dealId: 'deal-1' })
    expect(scheduleTargetIds('daily_summary', { id: 'summary' })).toEqual({ contactId: null })
    expect(scheduleTargetIds('custom', { id: 'trigger' })).toEqual({ contactId: null })
  })
})
