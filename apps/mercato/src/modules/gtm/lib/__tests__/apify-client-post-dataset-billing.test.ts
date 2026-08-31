import {
  runActorWithFinalizedBilling,
  type ApifyFetchInit,
  type ApifyFetchLike,
  type ApifyFetchResponse,
} from '../adapters/apify/client'

const TOKEN = 'apify_test_token_never_logged'
const ACTOR_ID = 'solidcode/reddit-scraper'
const RUN_ID = 'durable-reddit-run'
const DATASET_ID = 'durable-reddit-dataset'
const START_EVENT = 'apify-actor-start'
const RESULT_EVENT = 'apify-default-dataset-item'
const EVENT_PRICES = {
  [START_EVENT]: 0.01,
  [RESULT_EVENT]: 0.0022,
}

type FakeCall = { url: string; init: ApifyFetchInit }

function response(status: number, value: unknown): ApifyFetchResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(value),
  }
}

function runRecord(
  chargedEventCounts: Record<string, number>,
  usageTotalUsd: number,
  eventPrices: Record<string, number> = EVENT_PRICES,
) {
  return {
    id: RUN_ID,
    status: 'SUCCEEDED',
    defaultDatasetId: DATASET_ID,
    chargedEventCounts,
    usageTotalUsd,
    pricingInfo: {
      pricingModel: 'PAY_PER_EVENT',
      pricingPerEvent: {
        actorChargeEvents: Object.fromEntries(
          Object.entries(eventPrices).map(([event, eventPriceUsd]) => [event, { eventPriceUsd }]),
        ),
      },
    },
  }
}

function sequentialFetch(responses: ApifyFetchResponse[]): {
  fetchImpl: ApifyFetchLike
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const fetchImpl: ApifyFetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fake request')
    return next
  }
  return { fetchImpl, calls }
}

function runWith(
  responses: ApifyFetchResponse[],
  maxChargeUsd = 0.0122,
) {
  const { fetchImpl, calls } = sequentialFetch(responses)
  const outcome = runActorWithFinalizedBilling(
    ACTOR_ID,
    { queries: ['title:"looking to buy" subreddit:phoenix'] },
    {
      token: TOKEN,
      build: '1.1.36',
      timeoutMs: 1_000,
      maxItems: 1,
      maxChargeUsd,
      datasetFields: ['id', 'title', 'text', 'url'],
      billingContract: {
        pricingModel: 'PAY_PER_EVENT',
        eventPricesUsd: EVENT_PRICES,
      },
      datasetResultEvent: RESULT_EVENT,
      finalizationDelayMs: 0,
      sleep: async () => undefined,
      fetchImpl,
      now: () => new Date('2026-08-31T06:15:00.000Z'),
    },
  )
  return { outcome, calls }
}

describe('Apify same-run post-dataset billing convergence', () => {
  it('retains a durable row after its matching result charge appears without restarting the actor', async () => {
    const stale = runRecord({ [START_EVENT]: 1, [RESULT_EVENT]: 0 }, 0.01)
    const finalized = runRecord({ [START_EVENT]: 1, [RESULT_EVENT]: 1 }, 0.0122)
    const row = {
      id: 'phoenix-buyer-1',
      title: 'What is the scoop on Moon Valley?',
      text: 'We are looking to buy in Phoenix.',
      url: 'https://www.reddit.com/r/phoenix/comments/example',
    }
    const { outcome, calls } = runWith([
      response(201, { data: stale }),
      response(200, { data: stale }),
      response(200, [row]),
      response(200, { data: finalized }),
    ])

    await expect(outcome).resolves.toMatchObject({
      status: 'ok',
      kind: 'ok',
      runId: RUN_ID,
      itemCount: 1,
      items: [row],
      billingFinalized: true,
      chargedEventCounts: { [START_EVENT]: 1, [RESULT_EVENT]: 1 },
      providerCostUsd: 0.0122,
    })
    expect(calls.filter((call) => call.init.method === 'POST')).toHaveLength(1)
    expect(calls.filter((call) => call.url.includes(`/actor-runs/${RUN_ID}`))).toHaveLength(2)
    expect(calls.filter((call) => call.url.includes(`/datasets/${DATASET_ID}/items`))).toHaveLength(1)
    expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true)
  })

  it('parks post-dataset price drift and never starts a replacement actor run', async () => {
    const stale = runRecord({ [START_EVENT]: 1, [RESULT_EVENT]: 0 }, 0.01)
    const drifted = runRecord(
      { [START_EVENT]: 1, [RESULT_EVENT]: 1 },
      0.0123,
      { [START_EVENT]: 0.01, [RESULT_EVENT]: 0.0023 },
    )
    const { outcome, calls } = runWith([
      response(201, { data: stale }),
      response(200, { data: stale }),
      response(200, [{ id: 'phoenix-buyer-1' }]),
      response(200, { data: drifted }),
    ], 0.02)

    await expect(outcome).resolves.toMatchObject({
      status: 'ambiguous',
      kind: 'invalid_schema',
      runId: RUN_ID,
      items: [],
      chargedEventCounts: { [START_EVENT]: 1, [RESULT_EVENT]: 1 },
      providerCostUsd: 0.0123,
      error: 'invalid_schema: post-dataset billing evidence did not match the frozen contract',
    })
    expect(calls.filter((call) => call.init.method === 'POST')).toHaveLength(1)
  })
})
