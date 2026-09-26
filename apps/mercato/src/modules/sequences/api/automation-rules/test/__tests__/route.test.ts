const mockSession = { current: null as null | { orgId: string; tenantId: string } }
const mockDb: { knex: unknown } = { knex: null }

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: jest.fn(async () => mockSession.current),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({ resolve: () => ({ getKnex: () => mockDb.knex }) })),
}))
jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: unknown[]) => rows),
}))
jest.mock('../../../../../email/lib/email-router', () => ({
  sendEmailByPurpose: jest.fn(async () => ({ ok: false, error: 'email is not sent in tests' })),
}))

import { createFakeDb } from '../../../../../../lib/__tests__/support/fake-db'
import { POST } from '../route'

const ORG = 'org-1'
const TENANT = 'ten-1'
const CONTACT = 'contact-1'

function world(ruleOverrides: Record<string, unknown> = {}) {
  const knex = createFakeDb({
    automation_rules: [{
      id: 'rule-1',
      name: 'Welcome customers',
      organization_id: ORG,
      tenant_id: TENANT,
      trigger_type: 'contact_created',
      trigger_config: '{}',
      action_type: 'create_task',
      action_config: JSON.stringify({ taskTitle: 'Welcome call' }),
      conditions: JSON.stringify([{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }]),
      steps: null,
      status: 'active',
      is_active: true,
      ...ruleOverrides,
    }],
    automation_rule_logs: [],
    automation_scheduled_steps: [],
    tasks: [],
    customer_entities: [{
      id: CONTACT, organization_id: ORG, tenant_id: TENANT, display_name: 'Dana Buyer', primary_email: 'dana@example.com',
      primary_phone: null, source: 'manual', lifecycle_stage: 'customer', deleted_at: null,
    }],
    customer_tag_assignments: [],
    customer_tags: [],
  })
  mockDb.knex = knex
  return knex
}

async function call(body: Record<string, unknown>) {
  const res = await POST(new Request('http://crm.test/api/sequences/automation-rules/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  mockSession.current = { orgId: ORG, tenantId: TENANT }
})

describe('automation Test panel', () => {
  it('dry run evaluates the builder’s conditions and runs nothing', async () => {
    const knex = world()
    const { body } = await call({ ruleId: 'rule-1', contactId: CONTACT, dryRun: true })
    expect(body.data.conditions).toMatchObject({ allPass: true, items: [{ field: 'lifecycle_stage', operator: 'equals', actual: 'customer', passes: true }] })
    expect(body.data.executionResults).toBeNull()
    expect(knex.db.tables.tasks).toHaveLength(0)
    expect(knex.db.tables.automation_rule_logs).toHaveLength(0)
  })

  it('with dry run off it really runs the automation (it used to only write "executed")', async () => {
    const knex = world()
    const { body } = await call({ ruleId: 'rule-1', contactId: CONTACT, dryRun: false })
    expect(knex.db.tables.tasks).toHaveLength(1)
    expect(knex.db.tables.tasks[0]).toMatchObject({ title: 'Welcome call', contact_id: CONTACT, organization_id: ORG, tenant_id: TENANT })
    expect(body.data.executionResults).toEqual({ executed: true, message: 'Ran for real: 1 action done.' })
    expect(body.data.steps[0].result).toMatchObject({ status: 'executed' })
    expect(knex.db.tables.automation_rule_logs[0]).toMatchObject({ rule_id: 'rule-1', status: 'executed' })
  })

  it('reports a send that failed instead of claiming success', async () => {
    const knex = world({ action_type: 'send_email', action_config: JSON.stringify({ subject: 'Hi', body: 'Hello' }) })
    const { body } = await call({ ruleId: 'rule-1', contactId: CONTACT, dryRun: false })
    expect(body.data.executionResults.executed).toBe(false)
    expect(body.data.executionResults.message).toContain('failed (Email failed: email is not sent in tests)')
    expect(body.data.steps[0].result).toMatchObject({ status: 'failed' })
    expect(knex.db.tables.automation_rule_logs[0]).toMatchObject({ status: 'failed' })
  })

  it('does not run when the conditions fail', async () => {
    const knex = world()
    knex.db.tables.customer_entities[0]!.lifecycle_stage = 'prospect'
    const { body } = await call({ ruleId: 'rule-1', contactId: CONTACT, dryRun: false })
    expect(body.data.conditions.allPass).toBe(false)
    expect(body.data.executionResults).toBeNull()
    expect(knex.db.tables.tasks).toHaveLength(0)
  })

  it('a typed email address alone cannot run it for real, and says so', async () => {
    const knex = world({ conditions: null })
    const { body } = await call({ ruleId: 'rule-1', email: 'consumerprofile@protonmail.com', dryRun: false })
    expect(body.data.executionResults).toMatchObject({ executed: false })
    expect(body.data.executionResults.message).toMatch(/pick a saved contact/)
    expect(knex.db.tables.tasks).toHaveLength(0)
  })

  it('never reaches another tenant’s rule or contact', async () => {
    world()
    mockSession.current = { orgId: ORG, tenantId: 'ten-2' }
    expect((await call({ ruleId: 'rule-1', contactId: CONTACT, dryRun: false })).status).toBe(404)
  })
})
