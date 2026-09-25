/** @jest-environment node */
/* Two customer organisations in ONE shared tenant: org B's custom field
 * definitions (labels, options) and tombstones must not leak into, override
 * or hide org A's definitions. */

const TENANT = '22560ecc-0000-4000-8000-000000000000'
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000001'
const ENTITY = 'customers:customer_entity'

type Def = Record<string, any>
const defs: Def[] = [
  { entityId: ENTITY, key: 'budget', kind: 'text', tenantId: TENANT, organizationId: ORG_A, isActive: true, deletedAt: null, updatedAt: new Date('2026-01-01'), configJson: { label: 'A budget' } },
  { entityId: ENTITY, key: 'budget', kind: 'text', tenantId: TENANT, organizationId: ORG_B, isActive: true, deletedAt: null, updatedAt: new Date('2026-06-01'), configJson: { label: 'B secret label' } },
  { entityId: ENTITY, key: 'b_only', kind: 'text', tenantId: TENANT, organizationId: ORG_B, isActive: true, deletedAt: null, updatedAt: new Date('2026-06-01'), configJson: { label: 'B only field' } },
  { entityId: ENTITY, key: 'shared', kind: 'text', tenantId: TENANT, organizationId: null, isActive: true, deletedAt: null, updatedAt: new Date('2026-01-01'), configJson: { label: 'Tenant field' } },
  // B deleted its own "shared" override: that tombstone must not hide the field for A.
  { entityId: ENTITY, key: 'shared', kind: 'text', tenantId: TENANT, organizationId: ORG_B, isActive: true, deletedAt: new Date('2026-07-01'), updatedAt: new Date('2026-07-01'), configJson: {} },
]

function matches(row: Def, where: any): boolean {
  if (!where || typeof where !== 'object') return true
  for (const [key, cond] of Object.entries(where)) {
    if (key === '$and') { if (!(cond as any[]).every((c) => matches(row, c))) return false; continue }
    if (key === '$or') { if (!(cond as any[]).some((c) => matches(row, c))) return false; continue }
    const value = row[key]
    if (cond === undefined) continue
    if (cond === null) { if (value !== null && value !== undefined) return false; continue }
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>
      if ('$in' in c && !(c.$in as unknown[]).includes(value)) return false
      if ('$ne' in c) {
        if (c.$ne === null ? value === null || value === undefined : value === c.$ne) return false
      }
      continue
    }
    if (value !== cond) return false
  }
  return true
}

const mockEm = { find: jest.fn(async (_entity: unknown, where: any) => defs.filter((d) => matches(d, where))) }
let actorOrg = ORG_A

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (k: string) => {
      if (k === 'em') return mockEm
      throw new Error(`no ${k}`)
    },
  }),
}))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: async () => ({ sub: 'user', orgId: actorOrg, tenantId: TENANT, roles: ['admin'] }),
}))
jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: async () => ({ selectedId: actorOrg, filterIds: [actorOrg], allowedIds: [actorOrg], tenantId: TENANT }),
}))
jest.mock('../../lib/fieldsets', () => ({ loadEntityFieldsetConfigs: async () => new Map() }))

import { GET } from '../definitions'

async function labelsFor(org: string) {
  actorOrg = org
  const res = await GET(new Request(`http://x/api/entities/definitions?entityId=${encodeURIComponent(ENTITY)}`))
  expect(res.status).toBe(200)
  const json = await res.json()
  return Object.fromEntries((json.items as any[]).map((item) => [item.key, item.label]))
}

describe('GET /api/entities/definitions (shared tenant)', () => {
  it('org A sees its own and tenant-level definitions only', async () => {
    const labels = await labelsFor(ORG_A)
    expect(labels.budget).toBe('A budget')
    expect(labels).not.toHaveProperty('b_only')
    expect(labels.shared).toBe('Tenant field')
    expect(Object.values(labels)).not.toContain('B secret label')
  })

  it('org B sees its own definitions and its own tombstone', async () => {
    const labels = await labelsFor(ORG_B)
    expect(labels.budget).toBe('B secret label')
    expect(labels.b_only).toBe('B only field')
    expect(labels).not.toHaveProperty('shared')
  })
})
