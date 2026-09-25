/** @jest-environment node */

const mockCreateRequestContainer = jest.fn()
const mockGetAuth = jest.fn()
const mockHasSendingSetup = jest.fn()

let existingRule: Record<string, unknown> | undefined
const writes: Array<{ kind: string; payload: Record<string, unknown> }> = []

function createKnex() {
  return () => {
    const q: any = {
      where: jest.fn(() => q),
      first: jest.fn(async () => existingRule),
      insert: jest.fn(async (payload: Record<string, unknown>) => { writes.push({ kind: 'insert', payload }) }),
      update: jest.fn(async (payload: Record<string, unknown>) => { writes.push({ kind: 'update', payload }); return 1 }),
    }
    return q
  }
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: (...args: unknown[]) => mockGetAuth(...args),
}))
jest.mock('../../../../email/lib/routing-service', () => ({
  ...jest.requireActual('../../../../email/lib/routing-service'),
  hasSendingSetup: (...args: unknown[]) => mockHasSendingSetup(...args),
}))

import { POST, PUT } from '../route'

const MESSAGE = 'Connect an email account in Settings before turning on this automation; nothing will be sent until then. You can save it as paused meanwhile.'

function post(body: Record<string, unknown>) {
  return POST(new Request('https://crm.example.test/api/sequences/automation-rules', { method: 'POST', body: JSON.stringify(body) }))
}
function put(body: Record<string, unknown>) {
  return PUT(new Request('https://crm.example.test/api/sequences/automation-rules?id=rule-1', { method: 'PUT', body: JSON.stringify(body) }))
}

beforeEach(() => {
  jest.clearAllMocks()
  writes.length = 0
  existingRule = { id: 'rule-1', organization_id: 'org-1', action_type: 'send_email', steps: null }
  mockGetAuth.mockResolvedValue({ orgId: 'org-1', tenantId: 'tenant-1', sub: 'user-1' })
  mockCreateRequestContainer.mockResolvedValue({
    resolve: (name: string) => {
      if (name === 'em') return { getKnex: () => createKnex() }
      throw new Error(`unexpected resolve: ${name}`)
    },
  })
})

const EMAIL_RULE = { name: 'Welcome', triggerType: 'contact_created', actionType: 'send_email', actionConfig: { subject: 'Hi' } }

describe('automation rules: an email automation cannot be switched on without sending setup', () => {
  it('refuses creating an active email rule, writing nothing', async () => {
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await post({ ...EMAIL_RULE, status: 'active' })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ ok: false, code: 'email_not_connected', error: MESSAGE })
    expect(mockHasSendingSetup).toHaveBeenCalledWith(expect.anything(), 'org-1', 'automations')
    expect(writes).toHaveLength(0)
  })

  it('allows saving it paused', async () => {
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await post({ ...EMAIL_RULE, status: 'paused' })
    expect(res.status).toBe(201)
    expect(writes[0].payload).toMatchObject({ status: 'paused', is_active: false })
  })

  it('allows an active rule that sends no email', async () => {
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await post({ ...EMAIL_RULE, actionType: 'add_tag', status: 'active' })
    expect(res.status).toBe(201)
    expect(mockHasSendingSetup).not.toHaveBeenCalled()
  })

  it('refuses toggling an existing email rule on', async () => {
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await put({ status: 'active' })
    expect(res.status).toBe(422)
    expect(writes).toHaveLength(0)
  })

  it('refuses adding an email step to an already active rule (M4)', async () => {
    existingRule = { id: 'rule-1', organization_id: 'org-1', action_type: 'add_tag', steps: null, is_active: true }
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await put({ actionType: 'send_email', actionConfig: { subject: 'Hi' } })
    expect(res.status).toBe(422)
    expect(writes).toHaveLength(0)
    // Editing an active rule that sends no email needs no sending setup.
    const tag = await put({ name: 'Renamed' })
    expect(tag.status).toBe(200)
  })

  it('pausing never needs a sending setup, and activation works once connected', async () => {
    mockHasSendingSetup.mockResolvedValue(false)
    expect((await put({ status: 'paused' })).status).toBe(200)
    mockHasSendingSetup.mockResolvedValue(true)
    expect((await put({ status: 'active' })).status).toBe(200)
  })
})

describe('automation rules: toggles do what they say', () => {
  function putNoQuery(body: Record<string, unknown>) {
    return PUT(new Request('https://crm.example.test/api/sequences/automation-rules', { method: 'PUT', body: JSON.stringify(body) }))
  }

  it('honours { id, is_active } in the body (the assistant shape) and writes the toggle', async () => {
    mockHasSendingSetup.mockResolvedValue(true)
    const res = await putNoQuery({ id: 'rule-1', is_active: false })
    expect(res.status).toBe(200)
    expect(writes[0].payload).toMatchObject({ is_active: false, status: 'paused' })
  })

  it('switching on via is_active goes through the email_not_connected gate', async () => {
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await put({ is_active: true })
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('email_not_connected')
    expect(writes).toHaveLength(0)
  })

  it('isActive true writes active once connected', async () => {
    mockHasSendingSetup.mockResolvedValue(true)
    const res = await put({ isActive: true })
    expect(res.status).toBe(200)
    expect(writes[0].payload).toMatchObject({ is_active: true, status: 'active' })
  })

  it('an unknown rule is a 404, not a silent success', async () => {
    existingRule = undefined
    const res = await put({ isActive: false })
    expect(res.status).toBe(404)
    expect(writes).toHaveLength(0)
  })

  it('a non-boolean toggle is rejected', async () => {
    const res = await put({ is_active: 'yes' })
    expect(res.status).toBe(400)
    expect(writes).toHaveLength(0)
  })
})
