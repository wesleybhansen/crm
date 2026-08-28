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
  'real estate marketing',
  'lead generation',
  'case study',
  'housing market report',
  'real estate agent',
  'real estate broker',
  'realtor blog',
  'mortgage newsletter',
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

function sourceLocation(geography: string): string {
  const withoutCountry = geography
    .replace(/,?\s*(?:united states(?: of america)?|u\.?s\.?a\.?)\s*$/i, '')
    .trim()
  const parts = withoutCountry
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return parts.slice(0, 2).join(', ') || withoutCountry
}

function redditLocationWords(geography: string): string {
  return sourceLocation(geography).replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
}

function realtorSeeds(intent: OpportunityIntentLane, adapterId: string, geography: string): string[] {
  if (adapterId === 'dataforseo-organic-demand-opportunities') {
    if (intent === 'buyer_intent') {
      return [
        '"first time home buyer" question advice',
        '"buying my first home" question',
        '"house hunting" neighborhood advice',
        '"down payment assistance" workshop registration 2026',
        '"home buyer" community event registration 2026',
      ]
    }
    if (intent === 'seller_intent') {
      return [
        '"home seller" workshop registration 2026',
        '"selling my house" question advice',
        '"thinking of selling my house" advice',
        '"preparing my home for sale" discussion',
        '"home valuation" workshop homeowners 2026',
      ]
    }
    if (intent === 'mixed_intent') {
      return [
        '"buy before selling" home question',
        '"sell before buying" home advice',
        '"buying and selling a home" workshop 2026',
        '"selling and buying" home discussion',
        '"home buyer and seller" class 2026',
      ]
    }
    return [
      '"neighborhood association" meeting calendar 2026',
      '"homeowner community" meeting calendar 2026',
      '"home buyer workshop" registration 2026',
      '"home seller workshop" registration 2026',
      '"housing community event" calendar 2026',
    ]
  }
  if (adapterId === 'apify-reddit-demand-opportunities') {
    const location = redditLocationWords(geography)
    const market = marketName(geography)
    if (intent === 'buyer_intent') {
      return [
        '("buying a home" OR "buy a house" OR "first time home buyer" OR "house hunting")',
        `("mortgage pre approval" OR "down payment" OR "closing costs") AND ("${market}" OR "${location}")`,
        `("moving to ${market}" OR "relocating to ${market}" OR "buying in ${market}")`,
      ]
    }
    if (intent === 'seller_intent') {
      return [
        '("selling my home" OR "selling our home" OR "selling my house" OR "thinking of selling")',
        `("what is my home worth" OR "home valuation" OR "preparing to sell") AND ("${market}" OR "${location}")`,
        `("sell my house in ${market}" OR "selling my home in ${market}" OR "moving from ${market}")`,
      ]
    }
    if (intent === 'mixed_intent') {
      return [
        '("buy before selling" OR "sell before buying" OR "selling a home while buying")',
        `("buying and selling" OR "sell then buy") AND ("${market}" OR "${location}")`,
        `("moving to ${market}" OR "moving from ${market}") AND (buy OR sell)`,
      ]
    }
    return [
      '("neighborhood association" OR "community meeting" OR "homeowner event")',
      `("home buyer workshop" OR "home seller workshop" OR "housing event") AND ("${market}" OR "${location}")`,
      `(homeowner OR homebuyer) AND (meetup OR group OR forum OR community) AND ("${market}" OR "${location}")`,
    ]
  }
  const socialSeeds: Record<OpportunityIntentLane, string[]> = {
    buyer_intent: [
      '("buying a home" OR "house hunting" OR "first-time home buyer") AND ("I am" OR "we are") NOT (realtor OR agent OR broker OR mortgage OR lender)',
      '("first-time home buyer" OR "buy a house") AND (question OR advice) NOT realtor',
      '(homebuyer OR "buying a home") AND (workshop OR community) NOT realtor',
    ],
    seller_intent: [
      '("selling my home" OR "selling our home" OR "thinking of selling") AND ("I am" OR "we are") NOT (realtor OR agent OR broker OR mortgage OR lender)',
      '("thinking of selling" OR "home worth") AND (question OR advice) NOT realtor',
      '(homeowner OR "home seller") AND (workshop OR community) NOT realtor',
    ],
    mixed_intent: [
      '("buy before selling" OR "sell before buying") AND home NOT realtor',
      '("buying and selling" OR relocating) AND home NOT realtor',
      '(homebuyer OR homeowner) AND (workshop OR community) NOT realtor',
    ],
    local_audience: [
      '("homebuyer workshop" OR "homeowner association") AND community NOT realtor',
      '(neighborhood OR community) AND (homeowner OR housing) NOT realtor',
      '(homebuyer OR homeowner) AND (event OR group) NOT realtor',
    ],
  }
  return socialSeeds[intent]
}

function sourceMaxQueryLength(adapterId: string): number {
  if (adapterId === 'apify-x-demand-opportunities') return 100
  if (adapterId === 'apify-linkedin-demand-opportunities') return 200
  return 700
}

function marketName(geography: string): string {
  return geography.split(',')[0]?.trim() || geography
}

export function realtorMarketSubreddits(geography: string): string[] {
  const compact = marketName(geography).replace(/[^a-z0-9]/gi, '')
  const state = geography.split(',')[1]?.replace(/[^a-z0-9]/gi, '') ?? ''
  if (!compact) return []
  return unique([
    compact,
    `Ask${compact}`,
    state,
  ])
}

function realtorIntentSubreddits(geography: string, intent: OpportunityIntentLane): string[] {
  const market = realtorMarketSubreddits(geography)
  const intentCommunities: Record<OpportunityIntentLane, string[]> = {
    buyer_intent: ['FirstTimeHomeBuyer', 'RealEstate', 'homeowners'],
    seller_intent: ['RealEstate', 'homeowners', 'HomeImprovement'],
    mixed_intent: ['RealEstate', 'FirstTimeHomeBuyer', 'homeowners'],
    local_audience: ['RealEstate', 'homeowners', 'FirstTimeHomeBuyer'],
  }
  return unique([...market, ...intentCommunities[intent]])
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
    const location = sourceLocation(geography)
    const organicExclusions = new Set([
      'jobs',
      'recruiting',
      'just listed',
      'new listing',
      'market update',
      'real estate news',
    ])
    const exclusions = negativeTerms
      .filter((term) => organicExclusions.has(term))
      .map((term) => (term.includes(' ') ? `-${quoted(term)}` : `-${term}`))
      .join(' ')
    return `${quoted(location)} ${seed} ${exclusions}`
  }
  if (adapterId === 'apify-reddit-demand-opportunities') {
    return seed
  }
  if (adapterId === 'apify-linkedin-demand-opportunities') return `${quoted(market)} AND ${seed}`
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
  maxLanes = 5,
): OpportunityQueryLane[] {
  const providerQuery = play.providerQuery ?? {}
  const intent = inferredLane(play)
  const geography = (play.geography ?? '').trim().replace(/\s+/g, ' ')
  const playText = [play.audience, play.signal, ...values(providerQuery.audience_keywords)].join(' ')
  const realtor = REALTOR_PLAY.test(playText)
  const seeds = unique(realtor ? realtorSeeds(intent, adapterId, geography) : genericSeeds(play))
  // X has a material per-run initialization charge. One bounded query per play
  // keeps the same source coverage without paying that fixed charge three
  // times. LinkedIn also stays at one boolean query because the live actor can
  // outlast the synchronous wait boundary. Reddit retains three independently
  // quoted scopes. Organic search stays cheap per quoted SERP and gets five
  // narrow lanes so live participation surfaces do not compete with broad,
  // stale result pages inside one keyword.
  const sourceLaneCap =
    adapterId === 'apify-x-demand-opportunities'
    || adapterId === 'apify-linkedin-demand-opportunities'
      ? 1
      : adapterId === 'dataforseo-organic-demand-opportunities'
        ? 5
        : 3
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
        query_lane_version: 'opportunity-query-v17',
        source_query_lane_id: id,
        opportunity_intent_lane: intent,
        search_query: query,
        source_search_keywords: [query],
        negative_terms: negativeTerms,
        ...(adapterId === 'apify-reddit-demand-opportunities'
          ? index === 0
            ? {
                reddit_subreddits: realtorMarketSubreddits(geography),
                reddit_auto_discover: false,
                reddit_sort: 'new',
              }
            : index === 1
              ? {
                  reddit_subreddits: realtorIntentSubreddits(geography, intent),
                  reddit_auto_discover: false,
                  reddit_sort: 'relevance',
                }
              : {
                  // The actor's documented empty-scope mode is a global Reddit
                  // search, not subreddit auto-discovery. This final lane is
                  // explicit, market-bound in the query, and separately quoted.
                  reddit_subreddits: [],
                  reddit_auto_discover: false,
                  reddit_global_search: true,
                  reddit_sort: 'relevance',
                }
          : {}),
      },
    }
  })
}
