import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'

export const GTM_FIXTURE_NOLI_USER_ID =
  process.env.OM_GTM_FIXTURE_NOLI_USER_ID ?? '00000000-0000-4000-8000-000000000101'
export const GTM_FIXTURE_CLERK_USER_ID = 'user_gtm_ephemeral_admin'
export const GTM_FIXTURE_NOLI_ORG_ID = '00000000-0000-4000-8000-000000000201'
export const GTM_FIXTURE_INTERNAL_SECRET = 'om-ephemeral-gtm-internal-secret'

export async function postGtm(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown>,
  secret = GTM_FIXTURE_INTERNAL_SECRET,
) {
  return request.post(`/api${path}`, {
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      'x-request-id': `gtm-e2e-${randomUUID()}`,
    },
    data,
  })
}

export type SyntheticMailbox = {
  id: string
  organizationId: string
  tenantId: string
  userId: string
}

function databasePool() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required for GTM integration fixtures')
  return new Pool({ connectionString, max: 1 })
}

/** Creates a credential-free sender identity. Execution stays hard-off, so
 * this row can exercise approval and launch materialization without transport. */
export async function createSyntheticMailbox(): Promise<SyntheticMailbox> {
  const client = databasePool()
  try {
    const userResult = await client.query(
      `select id, tenant_id, organization_id
         from users
        where clerk_user_id = $1 and deleted_at is null
        limit 1`,
      [GTM_FIXTURE_CLERK_USER_ID],
    ) as { rows: Array<{
      id: string
      tenant_id: string
      organization_id: string
    }> }
    const user = userResult.rows[0]
    if (!user?.tenant_id || !user.organization_id) {
      throw new Error('Synthetic Noli identity has not been resolved into CRM')
    }
    const id = randomUUID()
    await client.query(
      `insert into email_connections
        (id, tenant_id, organization_id, user_id, provider, email_address,
         purpose, is_primary, is_active, created_at, updated_at, deleted_at)
       values ($1, $2, $3, $4, 'smtp', 'sender@synthetic.invalid',
         'gtm_integration_fixture', false, true, now(), now(), null)`,
      [id, user.tenant_id, user.organization_id, user.id],
    )
    return {
      id,
      organizationId: user.organization_id,
      tenantId: user.tenant_id,
      userId: user.id,
    }
  } finally {
    await client.end()
  }
}

/** The integration environment is disposable, but explicit cleanup keeps the
 * scenario retryable within one process and prevents cross-test coupling. */
export async function resetSyntheticGtmState(mailboxId?: string | null): Promise<void> {
  const client = databasePool()
  try {
    await client.query('begin')
    const tableResult = await client.query(
      `select tablename
         from pg_tables
        where schemaname = current_schema()
          and tablename like 'gtm\\_%' escape '\\'
        order by tablename`,
    ) as { rows: Array<{ tablename: string }> }
    const tables = tableResult.rows
      .map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`)
    if (tables.length > 0) {
      await client.query(`truncate table ${tables.join(', ')} restart identity cascade`)
    }
    if (mailboxId) {
      await client.query('delete from email_connections where id = $1', [mailboxId])
    }
    await client.query(
      'update users set clerk_user_id = null where clerk_user_id = $1',
      [GTM_FIXTURE_CLERK_USER_ID],
    )
    await client.query(
      'update organizations set noli_org_id = null where noli_org_id = $1',
      [GTM_FIXTURE_NOLI_ORG_ID],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}
