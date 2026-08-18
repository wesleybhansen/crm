import { FakeEm } from './support/fake-em'
import { ctx, seedWorkspace, TENANT, WORKSPACE } from './support/campaign-fixtures'
import {
  appendMessage,
  createThread,
  getMessages,
  GtmChatError,
  listThreads,
  GTM_CHAT_THREAD_LIST_CAP,
} from '../chat/store'
import { GtmAuditEvent, GtmChatMessage, GtmChatThread } from '../../data/entities'

describe('Strategist chat store (threads + append-only messages)', () => {
  it('creates a workspace-scoped thread and writes an audit event (no body text)', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const thread = await createThread(em, ctx, { workspaceId: WORKSPACE, title: '  Seed SaaS  ' })
    expect(thread.workspaceId).toBe(WORKSPACE)
    expect(thread.title).toBe('Seed SaaS') // trimmed
    expect(thread.status).toBe('active')
    expect(thread.lastMessageAt).toBeInstanceOf(Date)
    const audits = em.table(GtmAuditEvent).filter((a) => a.action === 'gtm.chat.thread_created')
    expect(audits).toHaveLength(1)
    expect(audits[0].objectId).toBe(thread.id)
    expect(audits[0].actorUserId).toBe(ctx.userId)
    // Audit metadata never carries message content.
    expect(JSON.stringify(audits[0].metadata)).not.toContain('Seed SaaS')
  })

  it('appends messages with a gap-free ascending seq and returns them chronologically', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const thread = await createThread(em, ctx, { workspaceId: WORKSPACE })
    const m1 = await appendMessage(em, ctx, { threadId: thread.id, role: 'user', content: { text: 'find seed SaaS' } })
    const m2 = await appendMessage(em, ctx, {
      threadId: thread.id,
      role: 'assistant',
      content: { text: 'here is a play', proposed_actions: [] },
    })
    const m3 = await appendMessage(em, ctx, {
      threadId: thread.id,
      role: 'tool',
      content: { tool: 'list_candidates', result: {} },
      toolRef: 'run-123',
    })
    expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3])
    expect(m3.toolRef).toBe('run-123')
    const rows = await getMessages(em, ctx, thread.id)
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'tool'])
    // One audit per append.
    expect(em.table(GtmAuditEvent).filter((a) => a.action === 'gtm.chat.message_appended')).toHaveLength(3)
  })

  it('append is race-safe: the (thread_id, seq) unique index rejects a duplicate seq', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const thread = await createThread(em, ctx, { workspaceId: WORKSPACE })
    await appendMessage(em, ctx, { threadId: thread.id, role: 'user', content: { text: 'a' } })
    // Force a collision by inserting a seq=2 row directly, then append: the
    // store recomputes and retries past the taken slot rather than throwing.
    const collide = em.create(GtmChatMessage, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      threadId: thread.id,
      role: 'assistant',
      content: { text: 'squatter' },
      seq: 2,
    })
    em.persist(collide)
    await em.flush()
    const next = await appendMessage(em, ctx, { threadId: thread.id, role: 'user', content: { text: 'b' } })
    expect(next.seq).toBe(3)
    const rows = await getMessages(em, ctx, thread.id)
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3])
  })

  it('lists threads newest-first and bumps last_message_at on append', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const t1 = await createThread(em, ctx, { workspaceId: WORKSPACE, title: 'older' })
    const t2 = await createThread(em, ctx, { workspaceId: WORKSPACE, title: 'newer' })
    // Push both threads' activity into the past so the append below is
    // unambiguously the most recent activity (append stamps last_message_at
    // to now).
    t1.lastMessageAt = new Date(Date.now() - 20_000)
    t2.lastMessageAt = new Date(Date.now() - 10_000)
    await appendMessage(em, ctx, { threadId: t1.id, role: 'user', content: { text: 'ping' } })
    const rows = await listThreads(em, ctx, WORKSPACE)
    expect(rows[0].id).toBe(t1.id) // bumped to newest by the append
    expect(rows.map((r) => r.title).sort()).toEqual(['newer', 'older'])
  })

  it('is self-scoped: a foreign-org workspace resolves workspace_not_found', async () => {
    const em = new FakeEm()
    await expect(
      createThread(em, ctx, { workspaceId: 'ffffffff-4444-4444-8444-444444444444' }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' })
  })

  it('is self-scoped: a foreign-org thread is not readable or appendable', async () => {
    const em = new FakeEm()
    const foreign = em.create(GtmChatThread, {
      organizationId: 'aaaaaaaa-9999-4999-8999-999999999999',
      tenantId: TENANT,
      workspaceId: 'ffffffff-4444-4444-8444-444444444444',
      status: 'active',
      lastMessageAt: new Date(),
    })
    em.persist(foreign)
    await em.flush()
    await expect(getMessages(em, ctx, foreign.id)).rejects.toMatchObject({ code: 'thread_not_found' })
    await expect(
      appendMessage(em, ctx, { threadId: foreign.id, role: 'user', content: { text: 'x' } }),
    ).rejects.toBeInstanceOf(GtmChatError)
  })

  it('rejects an unknown role and non-object content with typed errors', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const thread = await createThread(em, ctx, { workspaceId: WORKSPACE })
    await expect(
      appendMessage(em, ctx, { threadId: thread.id, role: 'system', content: { text: 'x' } }),
    ).rejects.toMatchObject({ code: 'invalid_role' })
    await expect(
      appendMessage(em, ctx, {
        threadId: thread.id,
        role: 'user',
        content: [] as unknown as Record<string, unknown>,
      }),
    ).rejects.toMatchObject({ code: 'invalid_content' })
  })

  it('exposes a thread list cap', () => {
    expect(GTM_CHAT_THREAD_LIST_CAP).toBe(50)
  })
})
