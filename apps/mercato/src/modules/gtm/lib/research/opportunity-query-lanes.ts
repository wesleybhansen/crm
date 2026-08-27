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
        '"I am looking to buy a home" question discussion',
        '"moving to" "house hunting" advice forum',
        '"first-time home buyer" upcoming workshop',
      ]
    }
    if (intent === 'seller_intent') {
      return [
        '"I am thinking about selling my home" question',
        '"I need to sell my house" advice forum',
        '"home seller" upcoming workshop',
      ]
    }
    if (intent === 'mixed_intent') {
      return [
        '"buy before selling" home question discussion',
        '"moving to" "sell my home" advice forum',
        '"home buyer" "home seller" upcoming workshop',
      ]
    }
    return [
      'neighborhood association directory homeowners community',
      'homebuyer education upcoming events workshops',
      'local housing questions community forum residents',
    ]
  }
  if (adapterId === 'apify-reddit-demand-opportunities') {
    if (intent === 'buyer_intent') {
      return [
        'self:yes ("buy a home" OR "buying a home" OR "house hunting")',
        'self:yes ("first-time home buyer" OR "first time home buyer")',
        'self:yes ("moving here" OR relocating) (home OR house)',
      ]
    }
    if (intent === 'seller_intent') {
      return [
        'self:yes ("sell my home" OR "selling my house" OR "selling our home")',
        'self:yes ("thinking of selling" OR "considering selling") (home OR house)',
        'self:yes ("home worth" OR "house worth") (sell OR selling)',
      ]
    }
    if (intent === 'mixed_intent') {
      return [
        'self:yes ("buy before selling" OR "sell before buying") home',
        'self:yes ("selling our home" OR "sell my home") (moving OR relocating)',
        'self:yes ("buying and selling" OR "sell and buy") home',
      ]
    }
    return [
      '(homeowner OR "home buyer" OR housing) (question OR advice OR discussion)',
      '(homebuyer OR homeowner) (workshop OR event OR class)',
      '(neighborhood OR community) (homeowner OR housing OR moving)',
    ]
  }
  const socialSeeds: Record<OpportunityIntentLane, string[]> = {
    buyer_intent: [
      '("buying a home" OR "house hunting") AND (question OR advice) NOT realtor',
      '("first-time home buyer" OR "moving here") AND (question OR advice) NOT realtor',
      '(homebuyer OR relocating) AND (workshop OR community) NOT realtor',
    ],
    seller_intent: [
      '("selling my home" OR "selling our home") AND (question OR advice) NOT realtor',
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
  if (!compact) return []
  return unique([
    compact,
    `Ask${compact}`,
    `${compact}Housing`,
    `${compact}RealEstate`,
  ])
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
  // times. LinkedIn also stays at one boolean query because the live actor can
  // outlast the synchronous wait boundary. Reddit and organic search retain
  // three independently quoted lanes.
  const sourceLaneCap =
    adapterId === 'apify-x-demand-opportunities'
    || adapterId === 'apify-linkedin-demand-opportunities'
      ? 1
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
        query_lane_version: 'opportunity-query-v6',
        source_query_lane_id: id,
        opportunity_intent_lane: intent,
        search_query: query,
        source_search_keywords: [query],
        negative_terms: negativeTerms,
        ...(adapterId === 'apify-reddit-demand-opportunities'
          ? { reddit_subreddits: realtorMarketSubreddits(geography) }
          : {}),
      },
    }
  })
}
