import { classifyOpportunityIntent } from './opportunity-quality'
import type { PlanPlayInput } from './plan'

export type OpportunityIntentLane =
  | 'buyer_intent'
  | 'seller_intent'
  | 'local_audience'
  | 'mixed_intent'

export type OpportunityQueryLane = {
  id: string
  intent: OpportunityIntentLane
  query: string
  negativeTerms: string[]
  providerQuery: Record<string, unknown>
}

const REALTOR_NEGATIVE_TERMS = [
  'jobs',
  'recruiting',
  'just listed',
  'new listing',
  'market update',
  'real estate news',
  'agent leads',
  'contact me',
  'buyer tips',
  'seller tips',
]

const REALTOR_PLAY =
  /\b(?:realtor|real estate|homeowners?|home ?buyers?|home ?sellers?|buying a home|selling a home|homeownership|housing)\b/i

function values(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
}

function unique(valuesToDedupe: string[]): string[] {
  const seen = new Set<string>()
  return valuesToDedupe.filter((value) => {
    const key = value.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function inferredLane(play: PlanPlayInput): OpportunityIntentLane {
  const query = play.providerQuery ?? {}
  const explicit = values(
    query.opportunity_intent_lane ?? query.intent_kind ?? query.opportunity_intent,
  )[0]
    ?.toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (
    explicit === 'buyer_intent'
    || explicit === 'seller_intent'
    || explicit === 'local_audience'
    || explicit === 'mixed_intent'
  ) {
    return explicit
  }
  const text = [
    play.audience,
    play.signal,
    ...values(query.search_query),
    ...values(query.source_search_keywords),
  ]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join(' ')
  return classifyOpportunityIntent(text).kind ?? 'local_audience'
}

function realtorSeeds(intent: OpportunityIntentLane, adapterId: string): string[] {
  if (adapterId === 'dataforseo-organic-demand-opportunities') {
    if (intent === 'buyer_intent') {
      return [
        'moving here buy home reddit forum',
        'first time home buyer workshop meetup event',
        'home buyer questions community discussion',
      ]
    }
    if (intent === 'seller_intent') {
      return [
        'selling my house reddit forum',
        'thinking about selling home question discussion',
        'home seller workshop meetup event',
      ]
    }
    if (intent === 'mixed_intent') {
      return [
        'buy or sell home question reddit forum',
        'moving housing decision community discussion',
        'home buyer seller workshop meetup event',
      ]
    }
    return [
      'homeowners neighborhood association community',
      'real estate discussion meetup group',
      'homebuyer workshop housing event',
    ]
  }
  if (adapterId === 'apify-reddit-demand-opportunities') {
    if (intent === 'buyer_intent') return ['moving buy home', 'first time home buyer', 'house hunting']
    if (intent === 'seller_intent') return ['sell my house', 'selling home question', 'home value']
    if (intent === 'mixed_intent') return ['buy sell home question', 'moving housing decision', 'local housing']
    return ['homeowners community', 'neighborhood housing', 'local home buyer']
  }
  if (intent === 'buyer_intent') {
    return ['first time home buyer question', 'looking to buy a home', 'moving here house hunting']
  }
  if (intent === 'seller_intent') {
    return ['thinking of selling my home', 'what is my home worth', 'preparing my house to sell']
  }
  if (intent === 'mixed_intent') {
    return ['buying or selling a home question', 'moving and home decision', 'local housing question']
  }
  return ['homeowner community', 'home buyer workshop', 'local housing discussion']
}

function sourceMaxQueryLength(adapterId: string): number {
  if (adapterId === 'apify-x-demand-opportunities') return 100
  if (adapterId === 'apify-linkedin-demand-opportunities') return 200
  return 700
}

function marketName(geography: string): string {
  return geography.split(',')[0]?.trim() || geography
}

function genericSeeds(play: PlanPlayInput): string[] {
  const query = play.providerQuery ?? {}
  const supplied = values(query.source_search_keywords)
  const authored = [play.audience, play.signal]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.replace(/\b(?:people|publicly|recent|current|demonstrating|considering|preparing)\b/gi, ' '))
  return unique([...supplied, ...authored])
}

function quoted(value: string): string {
  return `"${value.replace(/"/g, '').trim()}"`
}

function sourceSeed(
  adapterId: string,
  geography: string,
  seed: string,
  negativeTerms: string[],
): string {
  const market = marketName(geography)
  if (adapterId === 'dataforseo-organic-demand-opportunities') {
    const exclusions = negativeTerms
      .map((term) => (term.includes(' ') ? `-${quoted(term)}` : `-${term}`))
      .join(' ')
    return `${quoted(market)} ${seed} ${exclusions}`
  }
  if (adapterId === 'apify-reddit-demand-opportunities') {
    return `${market} ${seed}`
  }
  if (adapterId === 'apify-linkedin-demand-opportunities') return `${quoted(market)} ${seed}`
  if (adapterId === 'apify-x-demand-opportunities') return `${market} ${seed}`
  return `${market} ${seed}`
}

function bounded(value: string, max: number): string {
  const compact = value.trim().replace(/\s+/g, ' ')
  if (Array.from(compact).length <= max) return compact
  return Array.from(compact).slice(0, max).join('').replace(/\s+\S*$/, '').trim()
}

function queryFor(args: {
  adapterId: string
  geography: string
  seed: string
  negativeTerms: string[]
}): string {
  return bounded(
    sourceSeed(args.adapterId, args.geography, args.seed, args.negativeTerms),
    sourceMaxQueryLength(args.adapterId),
  )
}

/**
 * Produces a deterministic, paid-call-visible query set. The planner turns
 * each returned lane into its own quoted batch; adapters never fan out this
 * array behind a single reservation.
 */
export function buildOpportunityQueryLanes(
  play: PlanPlayInput,
  adapterId: string,
  maxLanes = 3,
): OpportunityQueryLane[] {
  const providerQuery = play.providerQuery ?? {}
  const intent = inferredLane(play)
  const geography = (play.geography ?? '').trim().replace(/\s+/g, ' ')
  const playText = [play.audience, play.signal, ...values(providerQuery.audience_keywords)].join(' ')
  const realtor = REALTOR_PLAY.test(playText)
  const seeds = unique(realtor ? realtorSeeds(intent, adapterId) : genericSeeds(play))
  // X has a material per-run initialization charge. One bounded query per play
  // keeps the same source coverage without paying that fixed charge three
  // times; the other sources retain three independently quoted lanes.
  const sourceLaneCap = adapterId === 'apify-x-demand-opportunities' ? 1 : 3
  const laneCap = Math.max(1, Math.min(maxLanes, sourceLaneCap))
  const selectedSeeds = seeds.slice(0, laneCap)
  const negativeTerms = realtor ? REALTOR_NEGATIVE_TERMS : []
  return selectedSeeds.map((seed, index) => {
    const id = `${intent}:${index + 1}`
    const query = queryFor({ adapterId, geography, seed, negativeTerms })
    return {
      id,
      intent,
      query,
      negativeTerms,
      providerQuery: {
        ...providerQuery,
        query_lane_version: 'opportunity-query-v4',
        source_query_lane_id: id,
        opportunity_intent_lane: intent,
        search_query: query,
        source_search_keywords: [query],
        negative_terms: negativeTerms,
      },
    }
  })
}
