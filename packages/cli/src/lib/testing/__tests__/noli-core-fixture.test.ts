import {
  NOLI_CORE_FIXTURE_CLERK_USER_ID,
  NOLI_CORE_FIXTURE_ORG_ID,
  NOLI_CORE_FIXTURE_SERVICE_KEY,
  NOLI_CORE_FIXTURE_USER_ID,
  startNoliCoreFixtureServer,
} from '../noli-core-fixture'

describe('ephemeral Noli Core fixture server', () => {
  it('serves only the synthetic identity, entitlement, and organization reads', async () => {
    const fixture = await startNoliCoreFixtureServer()
    const headers = { apikey: NOLI_CORE_FIXTURE_SERVICE_KEY }
    try {
      const user = await fetch(
        `${fixture.baseUrl}/rest/v1/users?id=eq.${NOLI_CORE_FIXTURE_USER_ID}`,
        { headers },
      )
      expect(user.status).toBe(200)
      await expect(user.json()).resolves.toEqual([
        expect.objectContaining({
          id: NOLI_CORE_FIXTURE_USER_ID,
          clerk_user_id: NOLI_CORE_FIXTURE_CLERK_USER_ID,
        }),
      ])

      const entitlement = await fetch(
        `${fixture.baseUrl}/rest/v1/entitlements?user_id=eq.${NOLI_CORE_FIXTURE_USER_ID}&app=eq.crm`,
        { headers },
      )
      await expect(entitlement.json()).resolves.toEqual([{ active: true }])

      const membership = await fetch(
        `${fixture.baseUrl}/rest/v1/organization_members?user_id=eq.${NOLI_CORE_FIXTURE_USER_ID}`,
        { headers },
      )
      await expect(membership.json()).resolves.toEqual([
        { organization_id: NOLI_CORE_FIXTURE_ORG_ID },
      ])
    } finally {
      await fixture.stop()
    }
  })

  it('rejects missing credentials, writes, and unknown relations', async () => {
    const fixture = await startNoliCoreFixtureServer()
    try {
      expect((await fetch(`${fixture.baseUrl}/rest/v1/users`)).status).toBe(401)
      expect((await fetch(`${fixture.baseUrl}/rest/v1/users`, {
        method: 'POST',
        headers: { apikey: NOLI_CORE_FIXTURE_SERVICE_KEY },
      })).status).toBe(405)
      expect((await fetch(`${fixture.baseUrl}/rest/v1/provider_operations`, {
        headers: { apikey: NOLI_CORE_FIXTURE_SERVICE_KEY },
      })).status).toBe(404)
    } finally {
      await fixture.stop()
    }
  })
})
