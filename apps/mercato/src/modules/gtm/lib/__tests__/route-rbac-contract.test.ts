import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

describe('GTM internal route RBAC contract', () => {
  it('enforces represented-user features on every authenticated internal route', () => {
    const internalDir = path.resolve(__dirname, '../../api/internal')
    const routeNames = readdirSync(internalDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    // The removal route is the sole intentional exception: it is the public,
    // account-free compliance path and carries no represented noliUserId.
    const protectedRoutes = routeNames.filter((name) => name !== 'removal-request')
    expect(protectedRoutes).toEqual([
      'campaigns',
      'candidates',
      'chat',
      'enrich',
      'execution',
      'gtm-inbox',
      'handoff',
      'import-audience-play',
      'overview',
      'plays',
      'privacy',
      'reconciliation',
      'research-runs',
      'strategy',
      'tasks',
    ])

    for (const routeName of protectedRoutes) {
      const source = readFileSync(path.join(internalDir, routeName, 'route.ts'), 'utf8')
      expect(source).toContain('hasGtmFeature')
      expect(source).toContain("error: 'Forbidden'")
    }
  })
})
