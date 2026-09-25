/* Two customer organisations in ONE shared tenant, sharing the seeded roles.
 * Role and feature fan-out must stay inside the source organisation (and its
 * ancestors): a leave request, quote or inbound email raised in A must never
 * notify B's admins. */
import type { Knex } from 'knex'
import {
  getRecipientUserIdsForFeature,
  getRecipientUserIdsForRole,
  resolveAudienceOrganizationIds,
} from '../lib/notificationRecipients'
import { createNotificationService } from '../lib/notificationService'
import handleNotificationJob from '../workers/create-notification.worker'

const TENANT = '22560ecc-0000-4000-8000-000000000000'
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const ORG_A1 = 'aaaaaaaa-0000-4000-8000-000000000002'
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000001'
const ADMIN_ROLE = 'role-admin-shared'
const SUPER_ROLE = 'role-superadmin'

type Row = Record<string, unknown>
type Tables = Record<string, Row[]>

const tables: Tables = {
  organizations: [
    { id: ORG_A, tenant_id: TENANT, ancestor_ids: [], deleted_at: null },
    { id: ORG_A1, tenant_id: TENANT, ancestor_ids: [ORG_A], deleted_at: null },
    { id: ORG_B, tenant_id: TENANT, ancestor_ids: [], deleted_at: null },
  ],
  users: [
    { id: 'user-a-admin', tenant_id: TENANT, organization_id: ORG_A, deleted_at: null },
    { id: 'user-a1-admin', tenant_id: TENANT, organization_id: ORG_A1, deleted_at: null },
    { id: 'user-b-admin', tenant_id: TENANT, organization_id: ORG_B, deleted_at: null },
    { id: 'user-b-direct', tenant_id: TENANT, organization_id: ORG_B, deleted_at: null },
    { id: 'user-root', tenant_id: TENANT, organization_id: null, deleted_at: null },
  ],
  user_roles: [
    { user_id: 'user-a-admin', role_id: ADMIN_ROLE, deleted_at: null },
    { user_id: 'user-a1-admin', role_id: ADMIN_ROLE, deleted_at: null },
    { user_id: 'user-b-admin', role_id: ADMIN_ROLE, deleted_at: null },
    { user_id: 'user-root', role_id: SUPER_ROLE, deleted_at: null },
  ],
  role_acls: [
    { role_id: ADMIN_ROLE, tenant_id: TENANT, features_json: ['staff.*', 'inbox_ops.*'], is_super_admin: false, deleted_at: null },
    { role_id: SUPER_ROLE, tenant_id: TENANT, features_json: [], is_super_admin: true, deleted_at: null },
  ],
  user_acls: [
    { user_id: 'user-b-direct', tenant_id: TENANT, features_json: ['staff.leave_requests.manage'], is_super_admin: false, deleted_at: null },
  ],
}

/** Minimal knex stand-in that really joins and filters the rows above. */
function fakeKnex(data: Tables): Knex {
  function builder(table: string) {
    let rows: Array<Record<string, Row>> = (data[table] ?? []).map((row) => ({ [table]: row }))
    const read = (joined: Record<string, Row>, column: string) => {
      const [t, c] = column.includes('.') ? column.split('.') : [table, column]
      return joined[t!]?.[c!]
    }
    let projection: string[] | null = null
    const api = {
      join(other: string, left: string, right: string) {
        const next: Array<Record<string, Row>> = []
        for (const joined of rows) {
          for (const row of data[other] ?? []) {
            const candidate = { ...joined, [other]: row }
            if (read(candidate, left) === read(candidate, right)) next.push(candidate)
          }
        }
        rows = next
        return api
      },
      where(column: string, value: unknown) {
        rows = rows.filter((joined) => read(joined, column) === value)
        return api
      },
      whereNull(column: string) {
        rows = rows.filter((joined) => read(joined, column) === null || read(joined, column) === undefined)
        return api
      },
      whereIn(column: string, values: unknown[]) {
        rows = rows.filter((joined) => values.includes(read(joined, column)))
        return api
      },
      select(...columns: string[]) {
        projection = columns
        return api
      },
      project(): Row[] {
        return rows.map((joined) => {
          const out: Row = {}
          for (const spec of projection ?? []) {
            const [source, alias] = spec.split(/\s+as\s+/i)
            const key = alias ?? (source!.includes('.') ? source!.split('.')[1]! : source!)
            out[key] = read(joined, source!)
          }
          return out
        })
      },
      async first() {
        return api.project()[0]
      },
      then(resolve: (value: Row[]) => unknown, reject?: (err: unknown) => unknown) {
        return Promise.resolve(api.project()).then(resolve, reject)
      },
    }
    return api
  }
  return builder as unknown as Knex
}

const knex = fakeKnex(tables)

describe('notification recipients: organization-scoped fan-out', () => {
  it('audience of an organization is itself plus its ancestors', async () => {
    expect((await resolveAudienceOrganizationIds(knex, TENANT, ORG_A1)).sort()).toEqual([ORG_A, ORG_A1].sort())
    expect(await resolveAudienceOrganizationIds(knex, TENANT, ORG_B)).toEqual([ORG_B])
    expect(await resolveAudienceOrganizationIds(knex, 'other-tenant', ORG_B)).toEqual([])
  })

  it('feature fan-out from A reaches A only, never B (role ACL and user ACL)', async () => {
    const recipients = await getRecipientUserIdsForFeature(knex, TENANT, 'staff.leave_requests.manage', ORG_A)
    expect(recipients).toEqual(['user-a-admin'])
    expect(recipients).not.toContain('user-b-admin')
    expect(recipients).not.toContain('user-b-direct')
    expect(recipients).not.toContain('user-root')
  })

  it('feature fan-out from a sub-organization also reaches the parent organization', async () => {
    const recipients = await getRecipientUserIdsForFeature(knex, TENANT, 'inbox_ops.proposals.view', ORG_A1)
    expect(recipients.sort()).toEqual(['user-a-admin', 'user-a1-admin'].sort())
  })

  it('feature fan-out from B reaches B only', async () => {
    const recipients = await getRecipientUserIdsForFeature(knex, TENANT, 'staff.leave_requests.manage', ORG_B)
    expect(recipients.sort()).toEqual(['user-b-admin', 'user-b-direct'].sort())
  })

  it('feature fan-out without an organization reaches super admins only', async () => {
    expect(await getRecipientUserIdsForFeature(knex, TENANT, 'staff.leave_requests.manage', null)).toEqual(['user-root'])
  })

  it('feature fan-out from an unknown organization reaches nobody', async () => {
    expect(await getRecipientUserIdsForFeature(knex, TENANT, 'staff.leave_requests.manage', 'no-such-org')).toEqual([])
  })

  it('role fan-out of the shared admin role stays inside the source organization', async () => {
    expect(await getRecipientUserIdsForRole(knex, TENANT, ADMIN_ROLE, ORG_A)).toEqual(['user-a-admin'])
    expect(await getRecipientUserIdsForRole(knex, TENANT, ADMIN_ROLE, ORG_B)).toEqual(['user-b-admin'])
    expect(await getRecipientUserIdsForRole(knex, TENANT, ADMIN_ROLE, null)).toEqual([])
  })
})

function buildEm() {
  const created: Array<Record<string, unknown>> = []
  const em: Record<string, unknown> = {
    create: (_entity: unknown, data: Record<string, unknown>) => {
      const row = { id: `n-${created.length + 1}`, ...data }
      created.push(row)
      return row
    },
    findOne: async () => null,
    flush: async () => undefined,
    persistAndFlush: async () => undefined,
    getConnection: () => ({ getKnex: () => knex }),
  }
  em.fork = () => em
  em.transactional = async (cb: (tx: unknown) => Promise<unknown>) => cb(em)
  return { em, created }
}

describe('notification service + worker: a leave request in A never notifies B', () => {
  const input = {
    type: 'staff.leave_request.submitted',
    title: 'Leave request',
    requiredFeature: 'staff.leave_requests.manage',
  }

  it('createForFeature uses the source organization', async () => {
    const { em } = buildEm()
    const service = createNotificationService({ em: em as never, eventBus: { emit: async () => undefined } })
    const notifications = await service.createForFeature(input as never, { tenantId: TENANT, organizationId: ORG_A })
    const recipients = notifications.map((n) => n.recipientUserId)
    expect(recipients).toEqual(['user-a-admin'])
  })

  it('createForRole uses the source organization', async () => {
    const { em } = buildEm()
    const service = createNotificationService({ em: em as never, eventBus: { emit: async () => undefined } })
    const notifications = await service.createForRole(
      { type: 'x', title: 'Role note', roleId: ADMIN_ROLE } as never,
      { tenantId: TENANT, organizationId: ORG_B },
    )
    expect(notifications.map((n) => n.recipientUserId)).toEqual(['user-b-admin'])
  })

  it('queued feature fan-out uses the job organization', async () => {
    const { em, created } = buildEm()
    await handleNotificationJob(
      { payload: { type: 'create-feature', input: input as never, tenantId: TENANT, organizationId: ORG_A } },
      { resolve: ((name: string) => (name === 'em' ? em : { emit: async () => undefined })) as never },
    )
    expect(created.map((n) => n.recipientUserId)).toEqual(['user-a-admin'])
  })
})
