import { bouncerEnabled, createBouncerVerifyAdapter } from '../adapters/bouncer/verify'

const approvedEnv = {
  GTM_BOUNCER_ENABLED: 'true',
  GTM_BOUNCER_API_KEY: 'test-key',
  GTM_BOUNCER_CUSTOMER_USE_APPROVED: 'true',
  GTM_BOUNCER_TERMS_VERSION: 'reviewed-2026-08-02',
  GTM_BOUNCER_PRICE_VERSION: 'payg-2026-08-02',
}

describe('Bouncer verification adapter', () => {
  it('stays dark until customer-use terms and pricing are frozen', () => {
    expect(bouncerEnabled({ GTM_BOUNCER_ENABLED: 'true', GTM_BOUNCER_API_KEY: 'key' })).toBe(false)
  })

  it.each([
    ['deliverable', null, 'no', 'verified', 1],
    ['risky', 'low_deliverability', 'yes', 'catch_all', 1],
    ['risky', 'low_quality', 'no', 'risky', 1],
    ['undeliverable', 'rejected_email', 'no', 'not_found', 1],
    ['unknown', 'timeout', 'unknown', 'unknown', 0],
  ])('maps %s to %s without conflating unknown with ambiguous', async (status, reason, acceptAll, expected, cost) => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      status, reason, score: 80, domain: { acceptAll },
    }), { status: 200, headers: { 'x-request-id': 'b-1' } })) as unknown as typeof fetch
    const adapter = createBouncerVerifyAdapter({ env: approvedEnv, fetchImpl })
    const result = await adapter.verify({
      signal_kind: 'email_verification', entity_unit: 'contacts', geography: 'US',
      channel: 'email', value: 'test@example.test',
    })
    expect(result.status).toBe('ok')
    expect(result.data?.verification_state).toBe(expected)
    expect(result.cost_units).toBe(cost)
  })

  it('parks non-timeout transport failures for reconciliation', async () => {
    const adapter = createBouncerVerifyAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockRejectedValue(new TypeError('connection reset')) as unknown as typeof fetch,
    })
    const result = await adapter.verify({
      signal_kind: 'email_verification', entity_unit: 'contacts', geography: 'US',
      channel: 'email', value: 'test@example.test',
    })
    expect(result).toEqual(expect.objectContaining({ status: 'ambiguous', cost_units: null }))
  })
})
