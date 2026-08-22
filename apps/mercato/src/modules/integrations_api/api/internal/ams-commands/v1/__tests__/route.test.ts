/** @jest-environment node */

import { POST } from '../route'

const originalEnv = process.env
const secret = 'ams-command-route-test-secret'

function request(authorization = `Bearer ${secret}`) {
  return {
    method: 'POST',
    headers: new Headers({ authorization, 'content-type': 'application/json' }),
    json: jest.fn(async () => {
      throw new Error('body must not be read')
    }),
  } as unknown as Request
}

describe('AMS CRM shadow command intake v1', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, NOLI_INTERNAL_SERVICE_SECRET: secret }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it.each([undefined, 'false', 'TRUE', '1'])('denies flag value %s before body or dependencies', async (flag) => {
    if (flag === undefined) delete process.env.NOLI_AMS_CRM_COMMAND_SHADOW_V1_ENABLED
    else process.env.NOLI_AMS_CRM_COMMAND_SHADOW_V1_ENABLED = flag
    const input = request()

    const response = await POST(input)

    expect(response.status).toBe(503)
    expect(input.json).not.toHaveBeenCalled()
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0')
  })

  it('rejects transport auth before body parsing', async () => {
    process.env.NOLI_AMS_CRM_COMMAND_SHADOW_V1_ENABLED = 'true'
    const input = request('Bearer wrong')

    const response = await POST(input)

    expect(response.status).toBe(401)
    expect(input.json).not.toHaveBeenCalled()
  })

  it('denies absent signer configuration before body parsing', async () => {
    process.env.NOLI_AMS_CRM_COMMAND_SHADOW_V1_ENABLED = 'true'
    delete process.env.NOLI_AMS_CRM_COMMAND_PUBLIC_KEYS_V1
    const input = request()

    const response = await POST(input)

    expect(response.status).toBe(503)
    expect(input.json).not.toHaveBeenCalled()
  })
})
