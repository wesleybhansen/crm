jest.mock('server-only', () => ({}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))
jest.mock('@open-mercato/core/modules/directory/data/entities', () => ({
  Organization: class Organization {},
}))
jest.mock('@open-mercato/shared/lib/noli/ai-usage', () => ({
  logCrmAiUsage: jest.fn(),
  logCrmAiUsageStrict: jest.fn(),
}))

import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { logCrmAiUsageStrict } from '@open-mercato/shared/lib/noli/ai-usage'
import { meterCustomersAiStrict } from '../meter'

const createRequestContainerMock = jest.mocked(createRequestContainer)
const logCrmAiUsageStrictMock = jest.mocked(logCrmAiUsageStrict)
const findOneMock = jest.fn()

const input = {
  noliUserId: 'noli-user-1',
  model: 'gemini-3.7-flash',
  tokensIn: 1_000,
  tokensOut: 100,
  feature: 'gtm-voice-derive',
  idempotencyKey: 'gtm:voice-derive:org-1:workspace-1:request-1',
}

describe('meterCustomersAiStrict', () => {
  beforeEach(() => {
    findOneMock.mockReset().mockResolvedValue({ noliOrgId: 'noli-org-1' })
    createRequestContainerMock.mockReset().mockResolvedValue({
      resolve: () => ({ findOne: findOneMock }),
    } as never)
    logCrmAiUsageStrictMock.mockReset().mockResolvedValue(undefined)
  })

  it('writes an awaited, idempotent receipt against the mapped Noli organization', async () => {
    await meterCustomersAiStrict({ orgId: 'crm-org-1' }, input)

    expect(logCrmAiUsageStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      noliOrgId: 'noli-org-1',
      noliUserId: 'noli-user-1',
      model: 'gemini-3.7-flash',
      idempotencyKey: input.idempotencyKey,
    }))
  })

  it('rejects an operation without an idempotency key before resolving the organization', async () => {
    await expect(meterCustomersAiStrict(
      { orgId: 'crm-org-1' },
      { ...input, idempotencyKey: null },
    )).rejects.toMatchObject({ code: 'idempotency_key_missing' })

    expect(createRequestContainerMock).not.toHaveBeenCalled()
  })

  it('rejects an organization that is not linked to Noli Core', async () => {
    findOneMock.mockResolvedValueOnce({ noliOrgId: null })

    await expect(meterCustomersAiStrict(
      { orgId: 'crm-org-1' },
      input,
    )).rejects.toMatchObject({ code: 'metering_identity_missing' })
  })

  it('surfaces a canonical usage write failure', async () => {
    logCrmAiUsageStrictMock.mockRejectedValueOnce(new Error('temporary Noli Core outage'))

    await expect(meterCustomersAiStrict(
      { orgId: 'crm-org-1' },
      input,
    )).rejects.toMatchObject({ code: 'metering_write_failed' })
  })
})
