import { GtmAuditEvent, GtmEvidence, GtmPostReply } from '../../data/entities'
import {
  POST_REPLY_DAILY_CAP,
  draftPostReply,
  editPostReply,
  markPostReplyCopied,
  postSourceFromCandidate,
  postThreadsReply,
  preparePostReply,
  reconcileStalePostingReplies,
  replySafetyProblem,
  storePostReply,
  type PostReplyEm,
} from '../post-replies'
import type { ThreadsConnectionAccess } from '../adapters/threads/connection'
import { FakeModel } from './support/fake-model'
import { FakeEm } from './support/fake-em'
import { ORG, TENANT, USER, seedCandidate, seedPlay, seedRun } from './support/campaign-fixtures'

const ctx = { organizationId: ORG, tenantId: TENANT, userId: USER, requestId: 'post-replies-test' }
const ON = { GTM_THREADS_REPLIES_ENABLED: 'true' }
const APPROVED = { customer_display: true, public_opportunity_use_allowed: true }
const REPLY = 'Congrats on getting ready to sell. Before listing, ask two or three local agents for a written pricing plan with recent nearby sales, and compare their marketing timelines. I help sellers here and am glad to walk through it with you.'

async function postLead(em: FakeEm, kind: 'threads' | 'reddit', license: Record<string, unknown> = APPROVED) {
  const play = await seedPlay(em)
  const run = await seedRun(em, play)
  const candidate = await seedCandidate(em, run, { email: null, evidenceClaim: null })
  const url = kind === 'threads' ? 'https://www.threads.com/@someone/post/ABC123' : 'https://www.reddit.com/r/SouthBay/comments/x1/selling_our_house/'
  candidate.entityKind = 'opportunity'
  candidate.identity = { name: 'Selling our house next spring', audience_description: 'We plan to sell our house in Torrance next spring. How do we pick an agent?', urls: [url] }
  em.persist(em.create(GtmEvidence, {
    organizationId: ORG,
    tenantId: TENANT,
    candidateId: candidate.id,
    researchRunId: run.id,
    claim: 'Public post',
    sourceUrl: url,
    confidence: '0.9',
    license,
    providerRef: kind === 'threads'
      ? { provider: 'meta_threads', detail: { provider: 'meta_threads', provider_post_id: '18012345678901234' } }
      : { provider: 'reddit', detail: { provider: 'reddit' } },
  }))
  await em.flush()
  return { play, candidate }
}

function connection(scopes = ['threads_basic', 'threads_keyword_search', 'threads_content_publish', 'threads_manage_replies']): ThreadsConnectionAccess & { invalid: string[] } {
  const invalid: string[] = []
  return {
    connectionId: '00000000-0000-4000-8000-00000000c0c0',
    providerUserId: '1',
    username: 'owner',
    scopes,
    invalid,
    remainingQueries: () => 100,
    reserveQuery: async () => true,
    getAccessToken: async () => 'token-abc',
    markInvalid: async (reason: string) => { invalid.push(reason) },
    recordUse: async () => undefined,
  }
}

function graph(responses: Array<{ status: number; body: unknown } | 'network'>) {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(String(url))
    const next = responses.shift()
    if (!next || next === 'network') throw new Error('socket hang up')
    return new Response(JSON.stringify(next.body), { status: next.status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

async function draftedRow(em: FakeEm, kind: 'threads' | 'reddit' = 'threads') {
  const { play, candidate } = await postLead(em, kind)
  const context = await preparePostReply(em, ctx, { workspaceId: play.workspaceId, playId: play.id, candidateId: candidate.id })
  return storePostReply(em, ctx, context, { bodyText: REPLY, model: 'fake-gemini' })
}

describe('post replies', () => {
  test('the safety screen refuses steering, links, hashtags, mentions and placeholders', () => {
    expect(replySafetyProblem(REPLY)).toBeNull()
    expect(replySafetyProblem('It is the safest part of town for young families.')).toBe('fair_housing_steering')
    expect(replySafetyProblem('Great schools there, happy to help.')).toBe('fair_housing_steering')
    expect(replySafetyProblem('See https://example.com for more.')).toBe('links_hashtags_or_mentions')
    expect(replySafetyProblem('Happy to help #realestate')).toBe('links_hashtags_or_mentions')
    expect(replySafetyProblem('Ask @someone about it')).toBe('links_hashtags_or_mentions')
    expect(replySafetyProblem('Call me at [phone number].')).toBe('placeholder')
    expect(replySafetyProblem('x'.repeat(481))).toBe('too_long')
  })

  test('a Threads lead carries the post id; a Reddit lead is copy-only; an unlicensed lead is refused', async () => {
    const em = new FakeEm()
    const threads = await postLead(em, 'threads')
    const reddit = await postLead(em, 'reddit')
    const unlicensed = await postLead(em, 'reddit', { customer_display: false })
    const evidenceFor = (id: string) => em.find(GtmEvidence, { candidateId: id })
    expect(postSourceFromCandidate(threads.candidate, await evidenceFor(threads.candidate.id))).toMatchObject({ platform: 'threads', providerPostId: '18012345678901234' })
    expect(postSourceFromCandidate(reddit.candidate, await evidenceFor(reddit.candidate.id))).toMatchObject({ platform: 'reddit', providerPostId: null })
    expect(postSourceFromCandidate(unlicensed.candidate, await evidenceFor(unlicensed.candidate.id))).toBeNull()
  })

  test('a drafted reply that fails the screen is refused, never stored', async () => {
    const em = new FakeEm()
    const { play, candidate } = await postLead(em, 'threads')
    const context = await preparePostReply(em, ctx, { workspaceId: play.workspaceId, playId: play.id, candidateId: candidate.id })
    const model = new FakeModel(() => ({ text: JSON.stringify({ reply: 'Torrance is one of the safest places for families, and I would love to help you sell there soon, just message me anytime.' }), model: 'fake-gemini', tokensIn: 10, tokensOut: 10 }))
    await expect(draftPostReply({ model }, context)).rejects.toMatchObject({ code: 'draft_failed' })
    const good = new FakeModel(() => ({ text: JSON.stringify({ reply: REPLY }), model: 'fake-gemini', tokensIn: 10, tokensOut: 10 }))
    await expect(draftPostReply({ model: good }, context)).resolves.toMatchObject({ bodyText: REPLY })
    expect(good.calls[0].prompt).toContain('<public_post>')
  })

  test('edits pass the same screen; copying marks the reply', async () => {
    const em = new FakeEm()
    const row = await draftedRow(em, 'reddit')
    await expect(editPostReply(em, ctx, { replyId: row.id, bodyText: 'Good schools nearby!' })).rejects.toMatchObject({ code: 'unsafe_reply' })
    await expect(markPostReplyCopied(em, ctx, { replyId: row.id })).resolves.toMatchObject({ status: 'copied', postable: false })
  })

  test('posting a Threads reply creates then publishes it, once', async () => {
    const em = new FakeEm()
    const row = await draftedRow(em)
    const { fetchImpl, calls } = graph([
      { status: 200, body: { id: '17000000000000001' } },
      { status: 200, body: { id: '17000000000000002' } },
      { status: 200, body: { permalink: 'https://www.threads.com/@owner/post/XYZ' } },
    ])
    const posted = await postThreadsReply(em as unknown as PostReplyEm, ctx, { replyId: row.id }, { connection: connection(), fetchImpl, env: ON })
    expect(posted).toMatchObject({ status: 'posted', reply_url: 'https://www.threads.com/@owner/post/XYZ' })
    expect(calls[0]).toContain('/me/threads')
    expect(calls[1]).toContain('/me/threads_publish')
    const again = await postThreadsReply(em as unknown as PostReplyEm, ctx, { replyId: row.id }, { connection: connection(), fetchImpl: graph([]).fetchImpl, env: ON })
    expect(again.status).toBe('posted')
    const audits = await em.find(GtmAuditEvent, { action: 'gtm.post_reply.posted' })
    expect(audits).toHaveLength(1)
  })

  test('a publish Noli cannot confirm is parked as unknown, never retried', async () => {
    const em = new FakeEm()
    const row = await draftedRow(em)
    const { fetchImpl } = graph([{ status: 200, body: { id: '17000000000000001' } }, 'network'])
    const result = await postThreadsReply(em as unknown as PostReplyEm, ctx, { replyId: row.id }, { connection: connection(), fetchImpl, env: ON })
    expect(result).toMatchObject({ status: 'unknown', failure_code: 'publish_outcome_unknown' })
    const retry = graph([])
    await postThreadsReply(em as unknown as PostReplyEm, ctx, { replyId: row.id }, { connection: connection(), fetchImpl: retry.fetchImpl, env: ON })
    expect(retry.calls).toHaveLength(0)
  })

  test('a missing reply permission asks for a reconnect without disabling search', async () => {
    const em = new FakeEm()
    const row = await draftedRow(em)
    const conn = connection()
    const { fetchImpl } = graph([{ status: 403, body: { error: { code: 10, message: 'permission' } } }])
    const result = await postThreadsReply(em as unknown as PostReplyEm, ctx, { replyId: row.id }, { connection: conn, fetchImpl, env: ON })
    expect(result).toMatchObject({ status: 'failed', failure_code: 'reconnect_required' })
    expect(conn.invalid).toHaveLength(0)
  })

  test('posting is refused when switched off, without the permissions, off Threads, or past the daily cap', async () => {
    const em = new FakeEm()
    const row = await draftedRow(em)
    const reddit = await draftedRow(em, 'reddit')
    const none = graph([]).fetchImpl
    await expect(postThreadsReply(em as unknown as PostReplyEm, ctx, { replyId: row.id }, { connection: connection(), fetchImpl: none, env: {} })).rejects.toMatchObject({ code: 'replies_unavailable' })
    await expect(postThreadsReply(em as unknown as PostReplyEm, ctx, { replyId: row.id }, { connection: connection(['threads_basic']), fetchImpl: none, env: ON })).rejects.toMatchObject({ code: 'reconnect_required' })
    await expect(postThreadsReply(em as unknown as PostReplyEm, ctx, { replyId: reddit.id }, { connection: connection(), fetchImpl: none, env: ON })).rejects.toMatchObject({ code: 'not_postable' })
    for (let i = 0; i < POST_REPLY_DAILY_CAP; i += 1) {
      const other = await draftedRow(em)
      await em.nativeUpdate(GtmPostReply, { id: other.id }, { status: 'posted', updatedAt: new Date() })
    }
    await expect(postThreadsReply(em as unknown as PostReplyEm, ctx, { replyId: row.id }, { connection: connection(), fetchImpl: none, env: ON })).rejects.toMatchObject({ code: 'daily_cap_reached' })
  })

  test('a reply stuck in posting after a crash becomes unknown, never re-posted (M3)', async () => {
    const em = new FakeEm()
    const stuck = await draftedRow(em)
    const fresh = await draftedRow(em)
    const old = new Date(Date.now() - 30 * 60 * 1000)
    await em.nativeUpdate(GtmPostReply, { id: stuck.id }, { status: 'posting', updatedAt: old })
    await em.nativeUpdate(GtmPostReply, { id: fresh.id }, { status: 'posting', updatedAt: new Date() })
    const moved = await reconcileStalePostingReplies(em as unknown as PostReplyEm, ctx)
    expect(moved).toBe(1)
    expect(await em.findOne(GtmPostReply, { id: stuck.id })).toMatchObject({ status: 'unknown', failureCode: 'posting_interrupted' })
    // A claim still inside its request window is left alone.
    expect((await em.findOne(GtmPostReply, { id: fresh.id }))?.status).toBe('posting')
    // Posting it again is a no-op read, not a second public reply.
    const none = graph([])
    const result = await postThreadsReply(em as unknown as PostReplyEm, ctx, { replyId: stuck.id }, { connection: connection(), fetchImpl: none.fetchImpl, env: ON })
    expect(result.status).toBe('unknown')
    expect(none.calls).toHaveLength(0)
  })

  test('the steering screen reads areas, not ordinary words, and sees through look-alikes (M9)', () => {
    expect(replySafetyProblem('Ask each agent for a rough estimate of net proceeds and an exclusive listing agreement term you can live with.')).toBeNull()
    expect(replySafetyProblem('The church parking lot hosts a free document shred day on Saturdays.')).toBeNull()
    expect(replySafetyProblem('That is a rough area, I would look elsewhere.')).toBe('fair_housing_steering')
    expect(replySafetyProblem('It is an exclusive neighborhood.')).toBe('fair_housing_steering')
    expect(replySafetyProblem('Great homes near the church.')).toBe('fair_housing_steering')
    expect(replySafetyProblem('Very s\u0430fe street.')).toBe('fair_housing_steering')
  })

  test('a draft the screen refuses is recorded but not charged (M9)', async () => {
    const em = new FakeEm()
    const { play, candidate } = await postLead(em, 'threads')
    const context = await preparePostReply(em, ctx, { workspaceId: play.workspaceId, playId: play.id, candidateId: candidate.id })
    const metered: Array<Record<string, unknown>> = []
    const model = new FakeModel(() => ({ text: JSON.stringify({ reply: 'Honestly the safest move is to buy in the good schools part of town, where young families live and prices hold up well over the long term for everyone.' }), model: 'fake-gemini', tokensIn: 900, tokensOut: 120 }))
    await expect(draftPostReply({ model, meter: async (usage) => { metered.push(usage as unknown as Record<string, unknown>) } }, context)).rejects.toMatchObject({ code: 'draft_failed' })
    expect(metered).toHaveLength(1)
    expect(metered[0]).toMatchObject({ status: 'failed', tokensIn: 0, tokensOut: 0 })
  })
})
