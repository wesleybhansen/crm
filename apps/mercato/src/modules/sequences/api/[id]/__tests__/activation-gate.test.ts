/** @jest-environment node */

const mockCreateRequestContainer = jest.fn()
const mockGetAuth = jest.fn()
const mockHasSendingSetup = jest.fn()

let sequenceRow: Record<string, unknown> | undefined
let stepRows: Array<{ step_type: string }> = []
const sequenceUpdates: Array<Record<string, unknown>> = []

function createKnex() {
  return (table: string) => {
    const q: any = {
      where: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      orderBy: jest.fn(async () => stepRows),
      select: jest.fn(async () => stepRows),
      first: jest.fn(async () => (table === 'sequences' ? sequenceRow : undefined)),
      update: jest.fn(async (patch: Record<string, unknown>) => {
        if (table === 'sequences') {
          sequenceUpdates.push(patch)
          if (sequenceRow) Object.assign(sequenceRow, patch)
        }
        return 1
      }),
      del: jest.fn(async () => 0),
      insert: jest.fn(async () => undefined),
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

import { PUT } from '../route'

function put(body: Record<string, unknown>) {
  return PUT(
    new Request('https://crm.example.test/api/sequences/seq-1', { method: 'PUT', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'seq-1' }) },
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  sequenceRow = { id: 'seq-1', organization_id: 'org-1', status: 'draft' }
  stepRows = [{ step_type: 'wait' }, { step_type: 'email' }]
  sequenceUpdates.length = 0
  mockGetAuth.mockResolvedValue({ orgId: 'org-1', tenantId: 'tenant-1', sub: 'user-1' })
  mockCreateRequestContainer.mockResolvedValue({
    resolve: (name: string) => {
      if (name === 'em') return { getKnex: () => createKnex() }
      throw new Error(`unexpected resolve: ${name}`)
    },
  })
})

describe('PUT /api/sequences/:id activation gate', () => {
  it('refuses to activate an email sequence when the org has no sending setup, changing nothing', async () => {
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await put({ status: 'active' })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body).toEqual({
      ok: false,
      code: 'email_not_connected',
      error: 'Connect an email account in Settings before activating this sequence; nothing will be sent until then.',
    })
    expect(mockHasSendingSetup).toHaveBeenCalledWith(expect.anything(), 'org-1', 'marketing')
    expect(sequenceUpdates).toHaveLength(0)
    expect(sequenceRow?.status).toBe('draft')
  })

  it('refuses resume from paused the same way', async () => {
    sequenceRow = { id: 'seq-1', organization_id: 'org-1', status: 'paused' }
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await put({ status: 'active' })
    expect(res.status).toBe(422)
    expect(sequenceUpdates).toHaveLength(0)
  })

  it('activates when sending is set up', async () => {
    mockHasSendingSetup.mockResolvedValue(true)
    const res = await put({ status: 'active' })
    expect(res.status).toBe(200)
    expect(sequenceUpdates[0]).toMatchObject({ status: 'active' })
  })

  it('a sequence with no email step activates without a sending check', async () => {
    stepRows = [{ step_type: 'wait' }, { step_type: 'sms' }]
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await put({ status: 'active' })
    expect(res.status).toBe(200)
    expect(mockHasSendingSetup).not.toHaveBeenCalled()
  })

  it('pausing never needs a sending setup', async () => {
    sequenceRow = { id: 'seq-1', organization_id: 'org-1', status: 'active' }
    mockHasSendingSetup.mockResolvedValue(false)
    const res = await put({ status: 'paused' })
    expect(res.status).toBe(200)
    expect(mockHasSendingSetup).not.toHaveBeenCalled()
  })
})
