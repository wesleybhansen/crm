/** @jest-environment node */

import { generateKeyPairSync } from 'node:crypto'
import { GET } from '../route'

const originalEnv = process.env
const secret = 'ams-crm-contract-test-secret'

function request(authorization = `Bearer ${secret}`): Request {
  return new Request('http://localhost/api/internal/ams-contract/v1', {
    headers: { authorization },
  })
}

describe('AMS CRM contract discovery v1', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, NOLI_INTERNAL_SERVICE_SECRET: secret }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('rejects invalid transport authentication', async () => {
    const response = await GET(request('Bearer wrong'))
    expect(response.status).toBe(401)
  })

  it('returns an authenticated no-store descriptor with every capability dark by default', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0')
    const body = await response.json()
    expect(body.descriptorSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(body.rollout).toEqual({
      commandShadowIntake: false,
      eligibilityLeases: false,
      eventPublication: false,
      providerDispatch: false,
    })
    expect(body.acceptedCommandKeyVersions).toEqual([])
  })

  it('publishes only key versions and exact-true interlocks', async () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    process.env.NOLI_AMS_CRM_COMMAND_PUBLIC_KEYS_V1 = JSON.stringify({
      'ams-command-2026-08': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    })
    process.env.NOLI_AMS_CRM_COMMAND_SHADOW_V1_ENABLED = 'true'
    process.env.NOLI_CRM_AMS_ELIGIBILITY_V1_ENABLED = 'TRUE'

    const body = await (await GET(request())).json()
    expect(body.acceptedCommandKeyVersions).toEqual(['ams-command-2026-08'])
    expect(body.rollout.commandShadowIntake).toBe(true)
    expect(body.rollout.eligibilityLeases).toBe(false)
    expect(JSON.stringify(body)).not.toContain('BEGIN PUBLIC KEY')
  })
})
