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

type OwnedMailboxInput = {
  senderEmail: string
  appPassword: string
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

/** Creates one Gmail SMTP/IMAP connection in the disposable R4 database.
 * The credential comes from the loopback broker and is never logged or
 * written to a repository artifact. */
export async function createOwnedGmailMailbox(input: OwnedMailboxInput): Promise<SyntheticMailbox> {
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
         smtp_host, smtp_port, smtp_user, smtp_pass,
         imap_host, imap_port, imap_secure,
         purpose, is_primary, is_active, created_at, updated_at, deleted_at)
       values ($1, $2, $3, $4, 'smtp', $5,
         'smtp.gmail.com', 587, $5, $6,
         'imap.gmail.com', 993, true,
         'gtm_owned_mailbox_e2e', false, true, now(), now(), null)`,
      [id, user.tenant_id, user.organization_id, user.id, input.senderEmail, input.appPassword],
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

/** Replaces one verified synthetic contact with the explicitly approved
 * owned recipient. No additional recipient can be enrolled in R4. */
export async function bindSingleOwnedRecipient(input: {
  organizationId: string
  tenantId: string
  recipientEmail: string
}): Promise<{ contactPointId: string; candidateId: string }> {
  const client = databasePool()
  try {
    const updated = await client.query(
      `with chosen as (
         select id
           from gtm_contact_points
          where organization_id = $1
            and tenant_id = $2
            and channel = 'email'
            and verification_state = 'verified'
            and deleted_at is null
          order by created_at, id
          limit 1
       )
       update gtm_contact_points point
          set value = $3,
              provenance = '{"method":"owned_mailbox_e2e"}'::jsonb,
              updated_at = now()
         from chosen
        where point.id = chosen.id
       returning point.id, point.candidate_id`,
      [input.organizationId, input.tenantId, input.recipientEmail],
    ) as { rows: Array<{ id: string; candidate_id: string }> }
    const row = updated.rows[0]
    if (!row) throw new Error('No verified synthetic recipient is available')
    await client.query(
      `update gtm_contact_points
          set verification_state = 'not_found', updated_at = now()
        where organization_id = $1
          and tenant_id = $2
          and channel = 'email'
          and id <> $3
          and deleted_at is null`,
      [input.organizationId, input.tenantId, row.id],
    )
    return { contactPointId: row.id, candidateId: row.candidate_id }
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
      await client.query('delete from email_messages where account_id = $1', [mailboxId])
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
