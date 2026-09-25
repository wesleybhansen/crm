/* Two customer organisations in ONE shared tenant: a message composed in A
 * may not be addressed to B's users (it would land in their inbox and, with
 * sendViaEmail, in their mailbox). */
import type { EntityManager } from '@mikro-orm/postgresql'
import { assertRecipientsInOrganization } from '../shared'

const TENANT = '22560ecc-0000-4000-8000-000000000000'
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const ORG_A1 = 'aaaaaaaa-0000-4000-8000-000000000002'
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000001'

const tables: Record<string, Array<Record<string, unknown>>> = {
  organizations: [
    { id: ORG_A, tenant_id: TENANT, ancestor_ids: [], descendant_ids: [ORG_A1], deleted_at: null },
    { id: ORG_A1, tenant_id: TENANT, ancestor_ids: [ORG_A], descendant_ids: [], deleted_at: null },
    { id: ORG_B, tenant_id: TENANT, ancestor_ids: [], descendant_ids: [], deleted_at: null },
  ],
  users: [
    { id: 'user-a', tenant_id: TENANT, organization_id: ORG_A, deleted_at: null },
    { id: 'user-a1', tenant_id: TENANT, organization_id: ORG_A1, deleted_at: null },
    { id: 'user-b', tenant_id: TENANT, organization_id: ORG_B, deleted_at: null },
  ],
}

function fakeEm(): EntityManager {
  const knex = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const api = {
      where(column: string, value: unknown) { rows = rows.filter((row) => row[column] === value); return api },
      whereIn(column: string, values: unknown[]) { rows = rows.filter((row) => values.includes(row[column])); return api },
      whereNull(column: string) { rows = rows.filter((row) => row[column] == null); return api },
      async first() { return rows[0] },
      async select() { return rows },
    }
    return api
  }
  return { getKnex: () => knex } as unknown as EntityManager
}

describe('message recipients are confined to the sender organization tree', () => {
  const em = fakeEm()

  it('allows recipients in the organization, its descendants and ancestors', async () => {
    await expect(assertRecipientsInOrganization(em, { tenantId: TENANT, organizationId: ORG_A }, ['user-a', 'user-a1'])).resolves.toBeUndefined()
    await expect(assertRecipientsInOrganization(em, { tenantId: TENANT, organizationId: ORG_A1 }, ['user-a'])).resolves.toBeUndefined()
  })

  it('refuses a recipient from another customer organization', async () => {
    await expect(assertRecipientsInOrganization(em, { tenantId: TENANT, organizationId: ORG_A }, ['user-a', 'user-b'])).rejects.toThrow(
      'Recipient belongs to another organization',
    )
    await expect(assertRecipientsInOrganization(em, { tenantId: TENANT, organizationId: ORG_B }, ['user-a'])).rejects.toThrow()
  })

  it('refuses unknown user ids and unknown organizations', async () => {
    await expect(assertRecipientsInOrganization(em, { tenantId: TENANT, organizationId: ORG_A }, ['ghost'])).rejects.toThrow()
    await expect(assertRecipientsInOrganization(em, { tenantId: TENANT, organizationId: 'nope' }, ['user-a'])).rejects.toThrow()
  })
})
