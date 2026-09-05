import { assessGenericOpportunitySuitability } from '../research/opportunity-quality'
import {
  GENERIC_EVENT_FILTER_VERSION,
  GENERIC_POST_FILTER_VERSION,
  GENERIC_THREAD_FILTER_VERSION,
  buildOpportunityQueryLanes,
  hasCityLevelGeography,
  opportunitySourceRouting,
  playFilterKeywords,
  playNamedSubreddits,
} from '../research/opportunity-query-lanes'
import type { PlanPlayInput } from '../research/plan'

/* Non-realtor consumer plays used to be locked out of the events, visual-social
 * and Reddit-thread sources because those adapters accepted only the realtor
 * filter contracts. These tests pin the generic path: what opens, what stays
 * realtor-only, and that the realtor plays are untouched. */

const founderPlay: PlanPlayInput = {
  marketType: 'b2c',
  geography: 'Austin, Texas',
  audience: 'first-time founders asking how to validate a side business idea in public communities',
  signal: 'a recent public question about validating an idea or finding first customers',
  signalKind: 'social_engagement',
  entityUnit: 'opportunities',
  sourceHint: 'Reddit r/SideProject and r/Entrepreneur threads',
  providerQuery: {
    opportunity_intent_lane: 'buyer_intent',
    source_search_keywords: ['how to validate a business idea', 'first customers'],
    audience_keywords: ['side business', 'first-time founder'],
    negative_terms: ['course launch'],
    locations: ['Austin, Texas'],
  },
}

const founderLocalPlay: PlanPlayInput = {
  ...founderPlay,
  audience: 'aspiring founders attending local startup pitch nights and meetups',
  signal: 'RSVPed to a founder meetup in the last 30 days',
  providerQuery: { ...founderPlay.providerQuery, opportunity_intent_lane: 'local_audience' },
}

const nationwideFounderPlay: PlanPlayInput = {
  ...founderPlay,
  geography: 'United States',
  providerQuery: { ...founderPlay.providerQuery, locations: ['United States'] },
}

const realtorPlay: PlanPlayInput = {
  marketType: 'b2c',
  geography: 'Austin, Texas',
  audience: 'Austin homebuyers publicly asking how to compare neighborhoods before purchasing',
  signal: 'a recent public question about buying a home in Austin',
  signalKind: 'social_engagement',
  entityUnit: 'opportunities',
  providerQuery: { opportunity_intent_lane: 'buyer_intent', source_search_keywords: ['buying a home in Austin'] },
}

describe('generic consumer suitability', () => {
  const keywords = ['side business', 'validate a business idea', 'first customers']

  it('keeps a public question that names what the play is about', () => {
    const result = assessGenericOpportunitySuitability(
      'How do I validate a business idea before quitting my job? Building a side business on evenings.',
      'buyer_intent',
      keywords,
      'thread',
    )
    expect(result).toEqual({ relevant: true, reasons: [] })
  })

  it('rejects content that never mentions anything the play named', () => {
    const result = assessGenericOpportunitySuitability(
      'Anyone know a good taco place downtown?',
      'buyer_intent',
      keywords,
      'thread',
    )
    expect(result.relevant).toBe(false)
    expect(result.reasons).toContain('missing_play_keyword')
  })

  it('rejects promotion even when it uses the right words', () => {
    const result = assessGenericOpportunitySuitability(
      'Launch your side business today! Use code FOUNDER20, limited time offer.',
      'buyer_intent',
      keywords,
      'post',
    )
    expect(result.relevant).toBe(false)
    expect(result.reasons).toContain('promotional_noise')
  })

  it('treats a public event or venue as local-audience participation', () => {
    const event = assessGenericOpportunitySuitability(
      'Founder pitch night and startup workshop for people starting a side business',
      'local_audience',
      keywords,
      'event',
    )
    expect(event.relevant).toBe(true)
  })
})

describe('non-realtor routing', () => {
  it('opens events and visual social sources for a city-level consumer play', () => {
    expect(opportunitySourceRouting(founderLocalPlay, 'apify-meetup-demand-opportunities').eligible).toBe(true)
    expect(opportunitySourceRouting(founderPlay, 'apify-eventbrite-demand-opportunities').eligible).toBe(true)
    expect(opportunitySourceRouting(founderPlay, 'apify-instagram-demand-opportunities').eligible).toBe(true)
    expect(opportunitySourceRouting(founderPlay, 'apify-tiktok-demand-opportunities').eligible).toBe(true)
    expect(opportunitySourceRouting(founderPlay, 'apify-facebook-demand-opportunities').eligible).toBe(true)
  })

  it('opens Reddit threads only when the play names the subreddit', () => {
    expect(playNamedSubreddits(founderPlay)).toEqual(['SideProject', 'Entrepreneur'])
    expect(opportunitySourceRouting(founderPlay, 'apify-reddit-thread-demand-opportunities').eligible).toBe(true)
    const unnamed = { ...founderPlay, sourceHint: 'public founder forums' }
    const routing = opportunitySourceRouting(unnamed, 'apify-reddit-thread-demand-opportunities')
    expect(routing.eligible).toBe(false)
    expect(routing.reason).toMatch(/name the public subreddit/)
  })

  it('keeps the residential phrase-bank Reddit contracts realtor-only', () => {
    for (const adapterId of [
      'apify-reddit-fresh-demand-opportunities',
      'apify-reddit-posted-after-demand-opportunities',
      'apify-reddit-api-demand-opportunities',
    ]) {
      expect(opportunitySourceRouting(founderPlay, adapterId).eligible).toBe(false)
    }
  })

  it('needs a city and state for events and public posts', () => {
    expect(hasCityLevelGeography('Austin, Texas')).toBe(true)
    expect(hasCityLevelGeography('United States')).toBe(false)
    expect(opportunitySourceRouting(nationwideFounderPlay, 'apify-eventbrite-demand-opportunities').eligible).toBe(false)
    expect(opportunitySourceRouting(nationwideFounderPlay, 'apify-instagram-demand-opportunities').eligible).toBe(false)
  })

  it('leaves realtor routing exactly as it was', () => {
    expect(opportunitySourceRouting(realtorPlay, 'apify-eventbrite-demand-opportunities').eligible).toBe(true)
    expect(opportunitySourceRouting(realtorPlay, 'apify-reddit-fresh-demand-opportunities').eligible).toBe(true)
    expect(opportunitySourceRouting(realtorPlay, 'apify-threads-demand-opportunities').eligible).toBe(false)
  })
})

describe('non-realtor lanes', () => {
  it('carries the generic filter versions and the play\'s own keywords', () => {
    const meetup = buildOpportunityQueryLanes(founderLocalPlay, 'apify-meetup-demand-opportunities')
    expect(meetup.length).toBeGreaterThan(0)
    expect(meetup[0]!.providerQuery.meetup_returned_content_filter_version).toBe(GENERIC_EVENT_FILTER_VERSION)
    expect(meetup[0]!.providerQuery.generic_filter_keywords).toEqual(playFilterKeywords(founderLocalPlay))
    expect(meetup[0]!.negativeTerms).toEqual(['course launch'])

    const eventbrite = buildOpportunityQueryLanes(founderPlay, 'apify-eventbrite-demand-opportunities')
    expect(eventbrite[0]!.providerQuery.eventbrite_returned_content_filter_version).toBe(GENERIC_EVENT_FILTER_VERSION)

    const instagram = buildOpportunityQueryLanes(founderPlay, 'apify-instagram-demand-opportunities')
    expect(instagram[0]!.providerQuery.social_returned_content_filter_version).toBe(GENERIC_POST_FILTER_VERSION)
    expect(instagram[0]!.providerQuery.social_filter_require_location).toBe(true)

    const thread = buildOpportunityQueryLanes(founderPlay, 'apify-reddit-thread-demand-opportunities')
    expect(thread[0]!.providerQuery.reddit_returned_content_filter_version).toBe(GENERIC_THREAD_FILTER_VERSION)
    expect(thread[0]!.providerQuery.reddit_subreddits).toEqual(['SideProject'])
    expect(thread[1]!.providerQuery.reddit_subreddits).toEqual(['Entrepreneur'])
  })

  it('hands the play\'s keywords to the official social lanes and keeps the realtor contract off them', () => {
    const xai = buildOpportunityQueryLanes(founderPlay, 'xai-x-search-demand-opportunities')
    expect(xai.length).toBeGreaterThan(0)
    expect(xai[0]!.providerQuery.generic_filter_keywords).toEqual(playFilterKeywords(founderPlay))
    expect(xai[0]!.providerQuery.social_returned_content_filter_version).toBeUndefined()
    const threads = buildOpportunityQueryLanes(founderPlay, 'threads-keyword-search-demand-opportunities')
    expect(threads[0]!.providerQuery.generic_filter_keywords).toEqual(playFilterKeywords(founderPlay))
    const realtorXai = buildOpportunityQueryLanes(realtorPlay, 'xai-x-search-demand-opportunities')
    expect(realtorXai[0]!.providerQuery.social_returned_content_filter_version).toBe('realtor-public-post-v2')
    expect(realtorXai[0]!.providerQuery.generic_filter_keywords).toBeUndefined()
  })

  it('draws keywords from the play, not from a vertical', () => {
    const keywords = playFilterKeywords(founderPlay)
    expect(keywords).toContain('side business')
    expect(keywords).toContain('how to validate a business idea')
    expect(keywords).toContain('validate')
    expect(keywords).not.toContain('people')
    expect(keywords.length).toBeLessThanOrEqual(12)
  })

  it('keeps realtor lanes on the realtor contracts', () => {
    const eventbrite = buildOpportunityQueryLanes(realtorPlay, 'apify-eventbrite-demand-opportunities')
    expect(eventbrite[0]!.providerQuery.eventbrite_returned_content_filter_version).toBe('realtor-public-event-v2')
    expect(eventbrite[0]!.providerQuery.generic_filter_keywords).toBeUndefined()
    const thread = buildOpportunityQueryLanes(realtorPlay, 'apify-reddit-thread-demand-opportunities')
    expect(thread[0]!.providerQuery.reddit_returned_content_filter_version).toBe('semantic-intent-location-v3')
  })
})
