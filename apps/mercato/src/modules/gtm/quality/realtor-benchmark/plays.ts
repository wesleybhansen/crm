import type { RealtorBenchmarkPlay } from './schemas'

const markets = [
  { slug: 'austin', market: 'Austin', geography: 'Austin, Texas' },
  { slug: 'denver', market: 'Denver', geography: 'Denver, Colorado' },
  { slug: 'phoenix', market: 'Phoenix', geography: 'Phoenix, Arizona' },
  { slug: 'tampa', market: 'Tampa', geography: 'Tampa, Florida' },
] as const

export const REALTOR_BENCHMARK_PLAYS: RealtorBenchmarkPlay[] = markets.flatMap((market) => [
  {
    id: `realtor-${market.slug}-buyer`,
    market: market.market,
    geography: market.geography,
    lane: 'buyer_intent',
    audience: `People publicly demonstrating that they are considering or preparing to buy a home in ${market.market}`,
    signal: 'A recent public question, discussion, workshop, or relocation conversation demonstrates home-buying intent.',
    entityUnit: 'post',
    recencyWindow: '30 days',
  },
  {
    id: `realtor-${market.slug}-seller`,
    market: market.market,
    geography: market.geography,
    lane: 'seller_intent',
    audience: `Homeowners publicly demonstrating that they are considering or preparing to sell a home in ${market.market}`,
    signal: 'A recent public question or discussion demonstrates home-selling, valuation, downsizing, or listing-preparation intent.',
    entityUnit: 'post',
    recencyWindow: '30 days',
  },
  {
    id: `realtor-${market.slug}-local`,
    market: market.market,
    geography: market.geography,
    lane: 'local_audience',
    audience: `Public communities, forums, groups, threads, events, and creator audiences where ${market.market} home buyers, sellers, owners, or movers gather`,
    signal: 'The destination is current, public, locally relevant, and offers a legitimate way to participate without inferring individual consent.',
    entityUnit: 'community',
    recencyWindow: '30 days',
  },
])
