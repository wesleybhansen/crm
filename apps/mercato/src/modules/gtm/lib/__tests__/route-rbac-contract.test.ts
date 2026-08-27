import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

describe('GTM internal route RBAC contract', () => {
  it('enforces represented-user features on every authenticated internal route', () => {
    const internalDir = path.resolve(__dirname, '../../api/internal')
    const routeNames = readdirSync(internalDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    // The removal route is the account-free compliance path. The retention
    // route is a shared-secret scheduled compliance process. Neither carries
    // a represented noliUserId, and neither exposes customer workspace reads.
    const protectedRoutes = routeNames.filter((name) => !['removal-request', 'retention'].includes(name))
    expect(protectedRoutes).toEqual([
      'auto-refill',
      'campaigns',
      'candidates',
      'chat',
      'decision-makers',
      'enrich',
      'execution',
      'gtm-inbox',
      'handoff',
      'import-audience-play',
      'manual-outreach',
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

  it('uses the represented Noli user for canonical provider metering', () => {
    const internalDir = path.resolve(__dirname, '../../api/internal')
    for (const routeName of ['research-runs', 'enrich', 'decision-makers']) {
      const source = readFileSync(path.join(internalDir, routeName, 'route.ts'), 'utf8')
      expect(source).toContain('findPrimaryOrgIdForUser')
      expect(source).toContain('noliOrgId,')
      expect(source).toContain('noliUserId: body.noliUserId')
      expect(source).not.toContain('noliUserId: userId')
    }
  })

  it('keeps the global retention process shared-secret-only and caller-unscoped', () => {
    const route = readFileSync(
      path.resolve(__dirname, '../../api/internal/retention/route.ts'),
      'utf8',
    )

    expect(route).toContain('requireProcessAuth(req, process.env.NOLI_INTERNAL_SERVICE_SECRET)')
    expect(route).toContain('sweepExpiredCandidates(')
    expect(route).not.toContain('req.json(')
    expect(route).not.toContain('orgId:')
    expect(route).not.toContain('now:')
  })
})
