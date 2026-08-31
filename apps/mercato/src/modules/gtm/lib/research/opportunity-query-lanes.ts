import { classifyOpportunityIntent } from './opportunity-quality'
import type { PlanPlayInput } from './plan'

export const DATAFORSEO_OPPORTUNITY_FRESHNESS_SEARCH_PARAM = '&tbs=qdr:m'
export const DATAFORSEO_EVENTS_OPPORTUNITY_DATE_RANGE = 'next_month'

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

export type OpportunitySourceRouting = {
  eligible: boolean
  reason: string | null
}

const REALTOR_NEGATIVE_TERMS = [
  'facebook',
  'instagram',
  'pinterest',
  'tiktok',
  'youtube',
  'jobs',
  'recruiting',
  'just listed',
  'new listing',
  'market update',
  'real estate news',
  'realtor',
  'broker',
  'open house',
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
  /\b(?:realtor|real estate|homeowners?|home ?buyers?|home ?sellers?|buy(?:ing)? a home|sell(?:ing)? a home|homeownership|housing)\b/i

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

function redditExactFieldPhraseSearch(phrase: string): string {
  const exact = quoted(phrase)
  return `(title:${exact} OR selftext:${exact})`
}

function redditExactPhraseBank(phrases: string[]): string {
  return `(${phrases.map(quoted).join(' OR ')})`
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

/**
 * Keeps paid opportunity sources on the lanes where the controlled benchmark
 * demonstrated useful recall. Reddit remains valuable for direct buyer and
 * seller conversations, but its realtor local-audience searches returned only
 * community noise and cannot prove participation rules. Local discovery is
 * therefore routed to the web/event adapters that can return a public venue,
 * date, and destination. Generic consumer plays retain their authored routing.
 */
export function opportunitySourceRouting(
  play: PlanPlayInput,
  adapterId: string,
): OpportunitySourceRouting {
  const intent = inferredLane(play)
  const providerQuery = play.providerQuery ?? {}
  const playText = [
    play.audience,
    play.signal,
    ...values(providerQuery.audience_keywords),
  ].join(' ')
  const realtor = REALTOR_PLAY.test(playText)

  if (
    (adapterId === 'apify-instagram-demand-opportunities'
      || adapterId === 'apify-tiktok-demand-opportunities'
      || adapterId === 'apify-facebook-demand-opportunities')
    && !realtor
  ) {
    return {
      eligible: false,
      reason: 'the initial public-post contract is limited to realtor buyer, seller, mixed, and local-audience plays',
    }
  }

  if (
    (adapterId === 'apify-reddit-thread-demand-opportunities'
      || adapterId === 'apify-reddit-fresh-demand-opportunities'
      || adapterId === 'apify-reddit-posted-after-demand-opportunities')
    && (!realtor || intent === 'local_audience')
  ) {
    return {
      eligible: false,
      reason: 'the governed Reddit post contracts are limited to realtor buyer, seller, and mixed-intent plays',
    }
  }

  if (
    adapterId === 'apify-reddit-fresh-demand-opportunities'
    && realtor
    && intent === 'seller_intent'
  ) {
    return {
      eligible: false,
      reason: 'the bounded realtor benchmark returned zero seller rows across repeated fresh Reddit phrase banks; seller discovery uses the governed public-web lanes',
    }
  }

  if (
    adapterId === 'apify-meetup-demand-opportunities'
    && (intent !== 'local_audience' || !realtor)
  ) {
    return {
      eligible: false,
      reason: 'Meetup is limited to realtor public local-audience events under the frozen housing-event filter contract',
    }
  }

  if (
    realtor
    && intent === 'local_audience'
    && adapterId === 'apify-reddit-demand-opportunities'
  ) {
    return {
      eligible: false,
      reason: 'realtor local-audience discovery requires a source that can prove a public venue, date, and participation path',
    }
  }

  return { eligible: true, reason: null }
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

function realtorSeeds(intent: OpportunityIntentLane, adapterId: string, geography: string): string[] {
  if (adapterId === 'apify-meetup-demand-opportunities') {
    return ['first time homebuyer workshop', 'home buying seminar', 'homeownership education']
  }
  if (adapterId === 'dataforseo-events-demand-opportunities') {
    if (intent === 'buyer_intent') {
      return ['first time home buyer workshop', 'home buyer seminar', 'homeownership class']
    }
    if (intent === 'seller_intent') {
      return ['home seller workshop', 'selling a home seminar', 'home valuation workshop']
    }
    if (intent === 'mixed_intent') {
      return ['buying and selling a home workshop', 'move up buyer seminar', 'home transition workshop']
    }
    return ['homeowner community event', 'housing workshop', 'neighborhood housing event']
  }
  if (adapterId === 'dataforseo-organic-demand-opportunities') {
    const subreddit = realtorMarketSubreddits(geography)[0]
      ?? marketName(geography).replace(/[^a-z0-9]/gi, '')
    const marketScope = `site:reddit.com/r/${subreddit}`
    if (intent === 'buyer_intent') {
      return [
        `${marketScope} "house hunting"`,
        '"looking to buy a house" public forum',
        '"looking for a realtor" public forum',
        'first time home buyer workshop registration',
        'home buyer seminar registration',
      ]
    }
    if (intent === 'seller_intent') {
      return [
        `${marketScope} "selling my house"`,
        '"thinking about selling my house" public forum',
        '"looking to sell my home" public forum',
        'home seller workshop registration',
        'selling your home seminar registration',
      ]
    }
    if (intent === 'mixed_intent') {
      return [
        `${marketScope} "sell before buying"`,
        '"buy before selling" public forum',
        '"sell then buy" public forum',
      ]
    }
    return [
      'neighborhood association public meeting calendar',
      'homeowner community meeting registration',
      'home buyer workshop registration',
      'home seller workshop registration',
      'housing community event registration',
    ]
  }
  if (adapterId === 'apify-reddit-demand-opportunities') {
    const market = marketName(geography)
    // clearpath/reddit-search-scraper treats long Boolean expressions as
    // brittle source-native searches. Keep each paid lane to one short phrase
    // and let the returned-content filter plus fit-v7 prove intent, locality,
    // freshness, access, safety, and actionability from the result itself.
    // Topic-community lanes intentionally search only the market name: their
    // frozen subreddit supplies topic scope, while returned content must still
    // independently demonstrate both the requested market and intent.
    const byIntent: Record<OpportunityIntentLane, string[]> = {
      buyer_intent: [
        'buying home',
        'house hunting',
        'first time home buyer',
        market,
        market,
      ],
      seller_intent: [
        'selling house',
        'realtor recommendation',
        'sell my house',
        market,
        market,
      ],
      mixed_intent: [
        'sell before buying',
        'move-up buyer',
        'selling and buying',
        market,
        market,
      ],
      local_audience: [
        'neighborhood association',
        'community meeting',
        `${market} housing workshop`,
      ],
    }
    return byIntent[intent]
  }
  if (adapterId === 'apify-reddit-thread-demand-opportunities') {
    const byIntent: Record<OpportunityIntentLane, string[]> = {
      buyer_intent: ['buying home', 'house hunting', 'first time home buyer'],
      seller_intent: ['selling house', 'realtor recommendation', 'sell my house'],
      mixed_intent: ['sell before buying', 'move-up buyer', 'selling and buying'],
      local_audience: [],
    }
    return byIntent[intent]
  }
  if (adapterId === 'apify-reddit-fresh-demand-opportunities') {
    const market = marketName(geography)
    const byIntent: Record<OpportunityIntentLane, string[]> = {
      buyer_intent: [
        redditExactFieldPhraseSearch('looking to buy'),
        redditExactFieldPhraseSearch('house hunting'),
        redditExactFieldPhraseSearch('looking for a realtor'),
        redditExactFieldPhraseSearch('buy a house'),
        redditExactFieldPhraseSearch('mortgage lender'),
      ],
      seller_intent: [
        redditExactFieldPhraseSearch('looking to sell'),
        redditExactFieldPhraseSearch('sell my house'),
        redditExactFieldPhraseSearch('selling my house'),
        redditExactFieldPhraseSearch('thinking about selling'),
        redditExactFieldPhraseSearch('realtor recommendation'),
      ],
      mixed_intent: [
        redditExactFieldPhraseSearch('sell before buying'),
        redditExactFieldPhraseSearch('buy before selling'),
        redditExactFieldPhraseSearch('selling and buying'),
        redditExactFieldPhraseSearch('move-up buyer'),
        redditExactFieldPhraseSearch(`moving in ${market}`),
      ],
      local_audience: [],
    }
    return byIntent[intent]
  }
  if (adapterId === 'apify-reddit-posted-after-demand-opportunities') {
    const market = marketName(geography)
    const buyer = redditExactPhraseBank([
      'looking to buy',
      'house hunting',
      'first time home buyer',
      'buy a house',
    ])
    const seller = redditExactPhraseBank([
      'looking to sell',
      'selling my house',
      'sell my house',
      'realtor recommendation',
    ])
    const mixed = redditExactPhraseBank([
      'sell before buying',
      'buy before selling',
      'selling and buying',
      'move up buyer',
    ])
    const byIntent: Record<OpportunityIntentLane, string[]> = {
      buyer_intent: [buyer, buyer, `${quoted(market)} AND ${buyer}`],
      seller_intent: [seller, seller, `${quoted(market)} AND ${seller}`],
      mixed_intent: [mixed, mixed, `${quoted(market)} AND ${mixed}`],
      local_audience: [],
    }
    return byIntent[intent]
  }
  if (adapterId === 'apify-threads-demand-opportunities') {
    // Threads search treats multiword input as a broad keyword search and can
    // return global matches for the intent phrase while ignoring the market.
    // Keep each lane to one market-bound token so a returned match cannot be
    // produced solely by a generic "home buyer" term. The evidence gate still
    // requires the returned post itself to prove market, intent, and recency.
    const marketToken = marketName(geography).replace(/[^a-z0-9]/gi, '').toLowerCase()
    const byIntent: Record<OpportunityIntentLane, string[]> = {
      buyer_intent: [`${marketToken}homebuyer`, `${marketToken}househunting`, `${marketToken}firsttimehomebuyer`],
      seller_intent: [`${marketToken}homeseller`, `${marketToken}sellingmyhome`, `${marketToken}homevalue`],
      mixed_intent: [`${marketToken}buyandsell`, `${marketToken}sellbeforebuying`, `${marketToken}movehome`],
      local_audience: [`${marketToken}homeowners`, `${marketToken}neighborhood`, `${marketToken}housingevent`],
    }
    return byIntent[intent]
  }
  if (adapterId === 'apify-x-demand-opportunities') {
    // The actor documents one keyword or hashtag term. Free-text keyword
    // bundles in the bounded v37 probe were tokenized broadly enough to match
    // author handles, Saint Austin, and generic "house hunting" content. Use
    // one market-bound hashtag per separately quoted lane so the retrieval
    // token itself is atomic. fit-v7 still proves location, intent, recency,
    // safety, and utility from returned content; the hashtag is targeting
    // provenance and never evidence.
    const marketToken = marketName(geography).replace(/[^a-z0-9]/gi, '')
    const byIntent: Record<OpportunityIntentLane, string[]> = {
      buyer_intent: [
        `#${marketToken}Homebuyer`,
        `#${marketToken}HouseHunting`,
        `#MovingTo${marketToken}`,
      ],
      seller_intent: [
        `#${marketToken}HomeSeller`,
        `#SellingIn${marketToken}`,
        `#${marketToken}HomeValue`,
      ],
      mixed_intent: [
        `#${marketToken}MoveUpBuyer`,
        `#${marketToken}BuyAndSell`,
        `#MovingIn${marketToken}`,
      ],
      local_audience: [
        `#${marketToken}HomebuyerWorkshop`,
        `#${marketToken}HomeownerEvent`,
        `#${marketToken}HousingEvent`,
      ],
    }
    return byIntent[intent]
  }
  if (adapterId === 'apify-instagram-demand-opportunities') {
    const marketToken = marketName(geography).replace(/[^a-z0-9]/gi, '')
    const byIntent: Record<OpportunityIntentLane, string[]> = {
      buyer_intent: [
        '#FirstTimeHomeBuyer',
        '#HouseHunting',
        `#${marketToken}`,
      ],
      seller_intent: [
        '#HomeSeller',
        '#SellingMyHome',
        `#${marketToken}`,
      ],
      mixed_intent: [
        '#MoveUpBuyer',
        '#BuyAndSellHome',
        `#${marketToken}`,
      ],
      local_audience: [
        `#${marketToken}`,
        `#${marketToken}Community`,
        `#${marketToken}Events`,
      ],
    }
    return byIntent[intent]
  }
  if (adapterId === 'apify-tiktok-demand-opportunities') {
    const market = marketName(geography)
    const byIntent: Record<OpportunityIntentLane, string[]> = {
      buyer_intent: [
        `${market} first time home buyer`,
        `${market} house hunting`,
        `moving to ${market} home`,
      ],
      seller_intent: [
        `selling my ${market} home`,
        `${market} home seller`,
        `${market} home value`,
      ],
      mixed_intent: [
        `${market} move up buyer`,
        `${market} buy and sell home`,
        `moving in ${market}`,
      ],
      local_audience: [
        `${market} homebuyer workshop`,
        `${market} homeowner community`,
        `${market} housing event`,
      ],
    }
    return byIntent[intent]
  }
  if (adapterId === 'apify-facebook-demand-opportunities') {
    const market = marketName(geography)
    const byIntent: Record<OpportunityIntentLane, string[]> = {
      buyer_intent: [
        `${market} first time home buyer`,
        `${market} house hunting`,
        `moving to ${market} home`,
      ],
      seller_intent: [
        `selling my ${market} home`,
        `${market} home seller question`,
        `thinking of selling in ${market}`,
      ],
      mixed_intent: [
        `${market} buy and sell home`,
        `${market} move up buyer`,
        `moving within ${market}`,
      ],
      local_audience: [
        `${market} homeowner community`,
        `${market} housing discussion`,
        `${market} homebuyer workshop`,
      ],
    }
    return byIntent[intent]
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
  if (adapterId === 'apify-threads-demand-opportunities') return 100
  if (adapterId === 'apify-instagram-demand-opportunities') return 100
  if (adapterId === 'apify-tiktok-demand-opportunities') return 100
  if (adapterId === 'apify-facebook-demand-opportunities') return 120
  if (adapterId === 'apify-linkedin-demand-opportunities') return 200
  if (adapterId === 'apify-reddit-thread-demand-opportunities') return 500
  if (adapterId === 'apify-reddit-fresh-demand-opportunities') return 500
  if (adapterId === 'apify-reddit-posted-after-demand-opportunities') return 500
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

function realtorTransactionTopicSubreddits(intent: OpportunityIntentLane): string[] {
  if (intent === 'buyer_intent') return ['FirstTimeHomeBuyer', 'RealEstate']
  if (intent === 'seller_intent') return ['homeowners', 'RealEstate']
  return ['RealEstate', 'homeowners']
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
): string {
  const market = marketName(geography)
  if (adapterId === 'dataforseo-events-demand-opportunities') return seed
  if (adapterId === 'dataforseo-organic-demand-opportunities') {
    const location = sourceLocation(geography)
    // DataForSEO reports 40101 only after the upstream search engine has
    // failed and DataForSEO has already retried the billable task. Keep paid
    // organic queries short and natural; fit-v7 applies the frozen negative
    // terms to returned content instead of making the query itself brittle.
    return `${location} ${seed}`
  }
  if (adapterId === 'apify-reddit-demand-opportunities') {
    return seed
  }
  if (adapterId === 'apify-reddit-thread-demand-opportunities') return seed
  if (adapterId === 'apify-reddit-fresh-demand-opportunities') return seed
  if (adapterId === 'apify-reddit-posted-after-demand-opportunities') return seed
  if (adapterId === 'apify-linkedin-demand-opportunities') return `${quoted(market)} AND ${seed}`
  if (adapterId === 'apify-x-demand-opportunities') {
    // Realtor X seeds bind the market inside the quoted phrase. Preserve the
    // generic-source prefix only when the authored seed does not already do so.
    return seed.toLowerCase().includes(market.toLowerCase()) ? seed : `${market} ${seed}`
  }
  if (adapterId === 'apify-threads-demand-opportunities') return seed
  if (adapterId === 'apify-instagram-demand-opportunities') return seed
  if (adapterId === 'apify-tiktok-demand-opportunities') return seed
  if (adapterId === 'apify-facebook-demand-opportunities') return seed
  if (adapterId === 'apify-meetup-demand-opportunities') return seed
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
}): string {
  return bounded(
    sourceSeed(args.adapterId, args.geography, args.seed),
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
  const realtorTransaction = realtor && intent !== 'local_audience'
  const authoredSeeds = realtor ? realtorSeeds(intent, adapterId, geography) : genericSeeds(play)
  // The two fixed Reddit topic-community lanes may intentionally use the same
  // market-name query against different frozen subreddits. Their scopes and
  // quote lane IDs are distinct even though the actor-native search text is
  // identical, so do not collapse them before planning.
  const seeds = (
    adapterId === 'apify-reddit-demand-opportunities'
    || adapterId === 'apify-reddit-fresh-demand-opportunities'
    || adapterId === 'apify-reddit-posted-after-demand-opportunities'
  ) && realtor
    ? authoredSeeds
    : unique(authoredSeeds)
  const sourceLaneCap =
    adapterId === 'apify-linkedin-demand-opportunities'
      ? 1
      : adapterId === 'apify-x-demand-opportunities'
        || adapterId === 'apify-threads-demand-opportunities'
        || adapterId === 'apify-instagram-demand-opportunities'
        || adapterId === 'apify-tiktok-demand-opportunities'
        || adapterId === 'apify-facebook-demand-opportunities'
        || adapterId === 'apify-meetup-demand-opportunities'
        || adapterId === 'apify-reddit-thread-demand-opportunities'
        || adapterId === 'apify-reddit-posted-after-demand-opportunities'
        ? 3
        : adapterId === 'apify-reddit-fresh-demand-opportunities' && realtorTransaction
          ? 5
        : adapterId === 'apify-reddit-demand-opportunities' && realtorTransaction
          ? 5
          : adapterId === 'dataforseo-organic-demand-opportunities'
            ? realtorTransaction ? 3 : 5
          : adapterId === 'dataforseo-events-demand-opportunities'
            ? 3
          : 3
  const laneCap = Math.max(1, Math.min(maxLanes, sourceLaneCap))
  const selectedSeeds = seeds.slice(0, laneCap)
  const negativeTerms = realtor ? REALTOR_NEGATIVE_TERMS : []
  return selectedSeeds.map((seed, index) => {
    const id = `${intent}:${index + 1}`
    const query = queryFor({ adapterId, geography, seed })
    const dataForSeoSiteScope =
      adapterId === 'dataforseo-organic-demand-opportunities' && realtorTransaction
        ? query.match(/(?:^|\s)site:([^\s()]+)/i)?.[1]?.replace(/[.,;]+$/, '') ?? null
        : null
    return {
      id,
      intent,
      query,
      negativeTerms,
      providerQuery: {
        ...providerQuery,
        query_lane_version:
          adapterId === 'apify-reddit-thread-demand-opportunities'
            ? 'opportunity-query-v64'
            : adapterId === 'apify-reddit-fresh-demand-opportunities'
            ? 'opportunity-query-v71'
            : adapterId === 'apify-reddit-posted-after-demand-opportunities'
            ? 'opportunity-query-v77'
            : adapterId === 'dataforseo-organic-demand-opportunities' && realtorTransaction
            ? 'opportunity-query-v73'
            : adapterId === 'apify-instagram-demand-opportunities'
            || adapterId === 'apify-tiktok-demand-opportunities'
            ? 'opportunity-query-v62'
            : adapterId === 'apify-facebook-demand-opportunities'
            ? 'opportunity-query-v74'
            : 'opportunity-query-v57',
        source_query_lane_id: id,
        opportunity_intent_lane: intent,
        search_query: query,
        source_search_keywords: [query],
        negative_terms: negativeTerms,
        ...(adapterId === 'dataforseo-organic-demand-opportunities'
          ? {
              search_param: DATAFORSEO_OPPORTUNITY_FRESHNESS_SEARCH_PARAM,
              ...(dataForSeoSiteScope
                ? {
                    dataforseo_price_operator_contract: 'single-positive-site-v1',
                    dataforseo_price_multiplier: 5,
                    dataforseo_site_scope: dataForSeoSiteScope,
                  }
                : {}),
            }
          : {}),
        ...(adapterId === 'dataforseo-events-demand-opportunities'
          ? { date_range: DATAFORSEO_EVENTS_OPPORTUNITY_DATE_RANGE }
          : {}),
        ...(adapterId === 'apify-meetup-demand-opportunities'
          ? {
              meetup_contract_version: 'public-events-v2',
              meetup_location: geography,
              meetup_event_type: 'PHYSICAL',
              meetup_country: 'us',
              meetup_radius_miles: 25,
              meetup_window_days: 30,
              meetup_min_rsvp_count: 1,
              meetup_sort: 'RELEVANCE',
              meetup_returned_content_filter_version: 'realtor-housing-event-v1',
            }
          : {}),
        ...(adapterId === 'apify-instagram-demand-opportunities'
          || adapterId === 'apify-tiktok-demand-opportunities'
          || adapterId === 'apify-facebook-demand-opportunities'
          ? {
              social_public_post_contract_version: 'public-posts-v1',
              social_returned_content_filter_version: 'realtor-public-post-v2',
              social_filter_required_intent: intent,
              social_filter_require_location: true,
              social_window_days: 30,
              ...(adapterId === 'apify-facebook-demand-opportunities'
                ? {
                    facebook_search_contract_version: 'public-search-posts-v1',
                    facebook_search_type: 'posts',
                  }
                : {}),
            }
          : {}),
        ...(adapterId === 'apify-reddit-thread-demand-opportunities'
          ? {
              reddit_thread_contract_version: 'public-post-comments-v2',
              reddit_returned_content_filter_version: 'semantic-intent-location-v3',
              reddit_filter_required_intent: intent,
              reddit_filter_require_location: false,
              reddit_subreddits:
                index === 1
                  ? realtorMarketSubreddits(geography).slice(1, 2)
                  : realtorMarketSubreddits(geography).slice(0, 1),
              reddit_auto_discover: false,
              reddit_global_search: false,
            }
          : {}),
        ...(adapterId === 'apify-reddit-fresh-demand-opportunities'
          ? {
              reddit_fresh_contract_version: 'public-post-search-v2',
              reddit_search_syntax_version: 'field-qualified-exact-phrase-bank-v4',
              reddit_fresh_window_days: 30,
              reddit_returned_content_filter_version: 'semantic-intent-location-v3',
              reddit_filter_required_intent: intent,
              reddit_filter_require_location: index >= 4,
              reddit_subreddits:
                index <= 2
                  ? realtorMarketSubreddits(geography).slice(0, 1)
                  : index === 3
                    ? realtorMarketSubreddits(geography).slice(1, 2)
                    : realtorTransactionTopicSubreddits(intent).slice(0, 1),
              reddit_auto_discover: false,
              reddit_global_search: false,
            }
          : {}),
        ...(adapterId === 'apify-reddit-posted-after-demand-opportunities'
          ? {
              locations: [geography],
              reddit_posted_after_contract_version: 'public-post-search-url-v1',
              reddit_search_syntax_version: 'exact-phrase-or-url-v1',
              reddit_posted_after_window_days: 30,
              reddit_returned_content_filter_version: 'semantic-intent-location-v4',
              reddit_filter_required_intent: intent,
              reddit_filter_require_location: index === 2,
              reddit_subreddits:
                index === 0
                  ? realtorMarketSubreddits(geography).slice(0, 1)
                  : index === 1
                    ? realtorMarketSubreddits(geography).slice(1, 2)
                    : [],
              reddit_auto_discover: false,
              reddit_global_search: index === 2,
            }
          : {}),
        ...(adapterId === 'apify-reddit-demand-opportunities'
          ? {
              ...(realtor
                ? {
                    reddit_returned_content_filter_version: 'semantic-intent-location-v3',
                    reddit_filter_required_intent: intent,
                    reddit_filter_require_location:
                      realtorTransaction
                        ? index >= 3
                        : intent === 'local_audience' && index === 2,
                  }
                : {
                    reddit_filter_keywords: [query].filter(Boolean),
                    reddit_filter_keyword_mode: 'any',
                  }),
              ...(realtorTransaction
            ? index === 0
              ? {
                  reddit_subreddits: realtorMarketSubreddits(geography).slice(0, 1),
                  reddit_auto_discover: false,
                  reddit_sort: 'relevance',
                  reddit_content_type: 'posts',
                }
              : index === 1
                ? {
                    reddit_subreddits: realtorMarketSubreddits(geography).slice(1, 2),
                    reddit_auto_discover: false,
                    reddit_sort: 'relevance',
                    reddit_content_type: 'posts',
                  }
              : index === 2
                  ? {
                      // Exact-market comments recover active demand expressed
                      // inside an existing local conversation. The source URL
                      // proves the market; query text never becomes evidence.
                      reddit_subreddits: realtorMarketSubreddits(geography).slice(0, 1),
                      reddit_auto_discover: false,
                      reddit_sort: 'relevance',
                      reddit_content_type: 'comments',
                    }
                : {
                    // Housing-topic communities provide additional recall, but
                    // unlike the exact-market lanes their returned content must
                    // independently demonstrate the requested market.
                    reddit_subreddits: realtorTransactionTopicSubreddits(intent).slice(index - 3, index - 2),
                    reddit_auto_discover: false,
                    reddit_sort: 'relevance',
                    reddit_content_type: 'posts',
                  }
            : index === 0
            ? {
                reddit_subreddits: realtorMarketSubreddits(geography).slice(0, 1),
                reddit_auto_discover: false,
                reddit_sort: 'relevance',
              }
            : index === 1
              ? {
                  reddit_subreddits: realtorMarketSubreddits(geography).slice(1, 2),
                  reddit_auto_discover: false,
                  reddit_sort: 'relevance',
                  reddit_content_type: 'posts',
                }
              : intent === 'buyer_intent' || intent === 'seller_intent' || intent === 'mixed_intent'
                ? {
                    // A second pass over the exact market's public comments
                    // improves recall for people expressing active demand in
                    // an existing conversation without paying for broad,
                    // mostly irrelevant subreddit discovery.
                    reddit_subreddits: realtorMarketSubreddits(geography).slice(0, 1),
                    reddit_auto_discover: false,
                    reddit_sort: 'relevance',
                    reddit_content_type: 'comments',
                  }
                : {
                    // Local-audience discovery still needs a broad public
                    // destination search because it is looking for communities
                    // and events rather than an individual's transaction intent.
                    reddit_subreddits: [],
                    reddit_auto_discover: true,
                    reddit_max_subreddits: 6,
                    reddit_global_search: true,
                    reddit_sort: 'relevance',
                    reddit_content_type: 'posts',
                  }
              ),
            }
          : {}),
      },
    }
  })
}
