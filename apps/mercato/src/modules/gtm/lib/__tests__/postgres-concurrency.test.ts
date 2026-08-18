import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'

const connectionString = process.env.GTM_TEST_DATABASE_URL
const describePostgres = connectionString ? describe : describe.skip

describePostgres('GTM real PostgreSQL concurrency contracts', () => {
  const pool = new Pool({ connectionString, max: 12 })
  const organizationId = randomUUID()
  const tenantId = randomUUID()

  afterAll(async () => {
    await pool.end()
  })

  it('allows exactly one concurrent mailbox lease winner', async () => {
    const cursorId = randomUUID()
    await pool.query(
      `insert into gtm_mailbox_cursors
        (id, organization_id, tenant_id, mailbox_connection_id, provider, cursor_kind, status, fence)
       values ($1, $2, $3, $4, 'gmail', 'gmail_history_id', 'idle', 0)`,
      [cursorId, organizationId, tenantId, randomUUID()],
    )
    const results = await Promise.all(Array.from({ length: 12 }, async () => pool.query(
      `update gtm_mailbox_cursors
          set lease_token = $1, lease_expires_at = now() + interval '2 minutes',
              fence = fence + 1, status = 'running'
        where id = $2 and organization_id = $3 and tenant_id = $4
          and (lease_expires_at is null or lease_expires_at <= now())
        returning fence`,
      [randomUUID(), cursorId, organizationId, tenantId],
    )))
    expect(results.filter((result) => result.rowCount === 1)).toHaveLength(1)
    const stored = await pool.query('select fence, status from gtm_mailbox_cursors where id = $1', [cursorId])
    expect(stored.rows[0]).toMatchObject({ fence: 1, status: 'running' })
  })

  it('rolls back a page message, GTM disposition, and cursor together, then commits them together', async () => {
    const cursorId = randomUUID()
    const mailboxId = randomUUID()
    const messageId = randomUUID()
    const eventId = randomUUID()
    const cursorHash = 'a'.repeat(64)
    await pool.query(
      `insert into gtm_mailbox_cursors
        (id, organization_id, tenant_id, mailbox_connection_id, provider, cursor_kind, status, fence)
       values ($1, $2, $3, $4, 'gmail', 'gmail_history_id', 'running', 1)`,
      [cursorId, organizationId, tenantId, mailboxId],
    )
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(
        `insert into email_messages
          (id, tenant_id, organization_id, account_id, direction, from_address, to_address,
           subject, body_html, status, tracking_id, metadata, created_at, updated_at)
         values ($1, $2, $3, $4, 'inbound', 'person@example.com', 'sender@example.com',
                 'reply', '', 'delivered', $5, '{}', now(), now())`,
        [messageId, tenantId, organizationId, mailboxId, randomUUID()],
      )
      await client.query(
        `update gtm_mailbox_cursors set cursor_hash = $1, status = 'idle'
          where id = $2 and organization_id = $3 and tenant_id = $4`,
        [cursorHash, cursorId, organizationId, tenantId],
      )
      await client.query(
        `insert into gtm_inbound_events
          (id, organization_id, tenant_id, mailbox_connection_id, provider, provider_event_id,
           dedupe_key, event_kind, processing_state, occurred_at)
         values ($1,$2,$3,$4,'gmail','event-page-rollback',$5,'human_reply','unmatched',now())`,
        [eventId, organizationId, tenantId, mailboxId, 'c'.repeat(64)],
      )
      await client.query('rollback')
      expect((await pool.query('select count(*)::int as count from email_messages where id = $1', [messageId])).rows[0].count).toBe(0)
      expect((await pool.query('select count(*)::int as count from gtm_inbound_events where id = $1', [eventId])).rows[0].count).toBe(0)
      expect((await pool.query('select cursor_hash from gtm_mailbox_cursors where id = $1', [cursorId])).rows[0].cursor_hash).toBeNull()

      await client.query('begin')
      await client.query(
        `insert into email_messages
          (id, tenant_id, organization_id, account_id, direction, from_address, to_address,
           subject, body_html, status, tracking_id, metadata, created_at, updated_at)
         values ($1, $2, $3, $4, 'inbound', 'person@example.com', 'sender@example.com',
                 'reply', '', 'delivered', $5, '{}', now(), now())`,
        [messageId, tenantId, organizationId, mailboxId, randomUUID()],
      )
      await client.query(
        `update gtm_mailbox_cursors set cursor_hash = $1, status = 'idle'
          where id = $2 and organization_id = $3 and tenant_id = $4`,
        [cursorHash, cursorId, organizationId, tenantId],
      )
      await client.query(
        `insert into gtm_inbound_events
          (id, organization_id, tenant_id, mailbox_connection_id, provider, provider_event_id,
           dedupe_key, event_kind, processing_state, occurred_at)
         values ($1,$2,$3,$4,'gmail','event-page-commit',$5,'human_reply','unmatched',now())`,
        [eventId, organizationId, tenantId, mailboxId, 'c'.repeat(64)],
      )
      await client.query('commit')
      expect((await pool.query('select count(*)::int as count from email_messages where id = $1', [messageId])).rows[0].count).toBe(1)
      expect((await pool.query('select count(*)::int as count from gtm_inbound_events where id = $1', [eventId])).rows[0].count).toBe(1)
      expect((await pool.query('select cursor_hash from gtm_mailbox_cursors where id = $1', [cursorId])).rows[0].cursor_hash).toBe(cursorHash)
    } finally {
      client.release()
    }
  })

  it('enforces mailbox health and inbound-event idempotency under concurrent inserts', async () => {
    const mailboxId = randomUUID()
    const health = await Promise.allSettled(Array.from({ length: 10 }, async () => pool.query(
      `insert into gtm_mailbox_health
        (id, organization_id, tenant_id, mailbox_connection_id, rolling_window_started_at)
       values ($1, $2, $3, $4, now() - interval '7 days')`,
      [randomUUID(), organizationId, tenantId, mailboxId],
    )))
    expect(health.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const event = await Promise.allSettled(Array.from({ length: 10 }, async () => pool.query(
      `insert into gtm_inbound_events
        (id, organization_id, tenant_id, mailbox_connection_id, provider, provider_event_id,
         dedupe_key, event_kind, occurred_at)
       values ($1, $2, $3, $4, 'gmail', 'event-1', $5, 'human_reply', now())`,
      [randomUUID(), organizationId, tenantId, mailboxId, 'b'.repeat(64)],
    )))
    expect(event.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })

  it('enforces one capacity slot across concurrently inserted attempts', async () => {
    const workspaceId = randomUUID()
    const playId = randomUUID()
    const runId = randomUUID()
    const candidateId = randomUUID()
    const campaignId = randomUUID()
    const versionId = randomUUID()
    const enrollmentId = randomUUID()
    const stepId = randomUUID()
    const setup = await pool.connect()
    await setup.query('begin')
    try {
      await setup.query(
        `insert into gtm_workspaces (id, organization_id, tenant_id, name) values ($1,$2,$3,'test')`,
        [workspaceId, organizationId, tenantId],
      )
      await setup.query(
        `insert into gtm_plays
          (id, organization_id, tenant_id, workspace_id, source, execution_eligibility)
         values ($1,$2,$3,$4,'authored','executable')`,
        [playId, organizationId, tenantId, workspaceId],
      )
      await setup.query(
        `insert into gtm_research_runs
          (id, organization_id, tenant_id, workspace_id, play_id)
         values ($1,$2,$3,$4,$5)`,
        [runId, organizationId, tenantId, workspaceId, playId],
      )
      await setup.query(
        `insert into gtm_candidates
          (id, organization_id, tenant_id, research_run_id, workspace_id, entity_kind, identity, dedupe_key)
         values ($1,$2,$3,$4,$5,'person','{}','candidate')`,
        [candidateId, organizationId, tenantId, runId, workspaceId],
      )
      await setup.query(
        `insert into gtm_campaigns
          (id, organization_id, tenant_id, workspace_id, play_id, name)
         values ($1,$2,$3,$4,$5,'test')`,
        [campaignId, organizationId, tenantId, workspaceId, playId],
      )
      await setup.query(
        `insert into gtm_campaign_versions
          (id, organization_id, tenant_id, campaign_id, version, snapshot, content_hash)
         values ($1,$2,$3,$4,1,'{}','hash')`,
        [versionId, organizationId, tenantId, campaignId],
      )
      await setup.query(
        `insert into gtm_enrollments
          (id, organization_id, tenant_id, campaign_id, campaign_version_id, candidate_id)
         values ($1,$2,$3,$4,$5,$6)`,
        [enrollmentId, organizationId, tenantId, campaignId, versionId, candidateId],
      )
      await setup.query(
        `insert into gtm_steps
          (id, organization_id, tenant_id, campaign_version_id, "order", channel, mode)
         values ($1,$2,$3,$4,1,'email','automated_email')`,
        [stepId, organizationId, tenantId, versionId],
      )
      await setup.query('commit')
    } catch (error) {
      await setup.query('rollback')
      throw error
    } finally {
      setup.release()
    }
    const slot = `v1:${randomUUID()}:2026-08-17:1`
    const inserts = await Promise.allSettled([1, 2].map(async (number) => pool.query(
      `insert into gtm_send_attempts
        (id, organization_id, tenant_id, enrollment_id, step_id, campaign_version_id,
         state, idempotency_key, capacity_slot_key)
       values ($1,$2,$3,$4,$5,$6,'approved',$7,$8)`,
      [randomUUID(), organizationId, tenantId, enrollmentId, stepId, versionId, `attempt-${number}`, slot],
    )))
    expect(inserts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })
})
