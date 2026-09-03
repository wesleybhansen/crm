import type { Candidate } from '../adapters/types'
import { validateOpportunityDestination } from '../research/opportunity-destination-validation'
import { assessOpportunityDestination } from '../research/opportunity-quality'

const CLOCK = new Date('2026-08-30T18:00:00.000Z')
const candidate = (url: string): Candidate => ({
  entity_kind: 'opportunity',
  identity: {
    name: 'Windsor Park neighborhood meetings',
    urls: [url],
    provider_location: 'Austin, Texas',
    opportunity_kind: 'group',
    platform: 'Public web',
    audience_description: 'A neighborhood association page for local homeowners.',
    access_type: 'unknown',
    participation_rules: 'Review the destination before participating.',
    participation_rules_status: 'unverified',
    recommended_action: 'Review the public meeting page and attend manually when permitted.',
    message_angle: 'Offer useful local housing information without unsolicited promotion.',
  },
  evidence: [{
    claim: 'The destination appeared in approved public search results.',
    source_url: url,
    observed_at: CLOCK.toISOString(),
    confidence: 0.72,
  }],
})

describe('opportunity destination validation', () => {
  it('retains bounded public-page evidence and source-observed participation terms', async () => {
    const fetchImpl = jest.fn(async () => new Response(`
      <html>
        <head><title>Windsor Park Neighborhood Association</title></head>
        <body><main>
          <p>Public neighborhood association meetings are held in Austin, Texas on the second Saturday.</p>
          <p>Residents may attend the meeting and register for community updates.</p>
        </main></body>
      </html>
    `, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }))

    const result = await validateOpportunityDestination(candidate('https://windsorpark.example/meetings'), {
      fetchImpl,
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('verified')
    expect(result.candidate.identity).toMatchObject({
      access_type: 'public',
      destination_validation_status: 'verified_public',
      destination_validated_at: CLOCK.toISOString(),
      destination_http_status: 200,
      location: 'Austin, Texas',
      participation_rules_status: 'observed',
    })
    // The rule sentence is the permission sentence ("Residents may attend"),
    // not any sentence that happens to mention meetings (H2).
    expect(result.candidate.identity.participation_rules).toContain('Residents may attend')
    expect(result.candidate.identity.audience_description).toContain('Windsor Park Neighborhood Association')
    expect(result.candidate.evidence.at(-1)).toMatchObject({
      source_url: 'https://windsorpark.example/meetings',
      detail: {
        validator: 'safe-public-destination-v4',
        http_status: 200,
      },
    })
    expect(assessOpportunityDestination({
      identity: result.candidate.identity,
      evidence: result.candidate.evidence,
      referenceTime: CLOCK,
      maxAgeDays: 30,
      content: result.candidate.identity.audience_description,
    }).status).toBe('pass')
  })

  it('does not directly crawl social-network destinations', async () => {
    const fetchImpl = jest.fn()
    const original = candidate('https://www.reddit.com/r/Austin/comments/example/question')
    const result = await validateOpportunityDestination(original, { fetchImpl, now: () => CLOCK })

    expect(result).toEqual({ candidate: original, outcome: 'skipped_social' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('prioritizes source-demonstrated locality even when it appears after generic page copy', async () => {
    const result = await validateOpportunityDestination(candidate('https://windsorpark.example/meetings'), {
      fetchImpl: async () => new Response(`
        <html><head><title>Neighborhood Association Meetings</title></head><body><main>
          <p>Neighborhood association meetings are held every month.</p>
          <p>Homeowners hear community updates and housing information.</p>
          <p>Members discuss neighborhood projects and local events.</p>
          <p>The community calendar includes workshops and public meetings.</p>
          <p>Residents can join the association and volunteer.</p>
          <p>Meeting materials are posted after every session.</p>
          <p>Austin Neighborhood Council meetings are held at the Austin Energy Building, 721 Barton Springs Road, Austin, Texas.</p>
        </main></body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } }),
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('verified')
    expect(result.candidate.identity.location).toBe('Austin, Texas')
    expect(result.candidate.identity.audience_description).toContain('Austin Neighborhood Council')
  })

  it('prioritizes an observed professional-attendance restriction over generic registration copy', async () => {
    const result = await validateOpportunityDestination(candidate('https://events.example/restricted-workshop'), {
      fetchImpl: async () => new Response(`
        <html><head><title>Buy your next house without selling</title></head><body><main>
          <p>Register for this Austin homeowner workshop on September 15, 2026.</p>
          <p>As this event is hosted by Open House Austin, we are currently not allowing agents, brokers, or lenders to attend due to a conflict of interest.</p>
        </main></body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } }),
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('verified')
    expect(result.candidate.identity.participation_rules_status).toBe('observed')
    expect(result.candidate.identity.participation_rules).toContain('not allowing agents')
  })

  it('replaces a stale snippet date with the future event date demonstrated by the public page', async () => {
    const original = candidate('https://events.example/historic-homes-tour')
    original.identity.opportunity_kind = 'event'
    original.identity.event_start_at = '2026-08-09T12:00:00.000Z'

    const result = await validateOpportunityDestination(original, {
      fetchImpl: async () => new Response(`
        <html><head><title>Historic Homes Tour</title></head><body><main>
          <p>Published August 9, 2026.</p>
          <p>Join the neighborhood association for the public Historic Homes Tour on November 15, 2026.</p>
          <p>Residents and visitors may register and attend in Austin, Texas.</p>
        </main></body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } }),
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('verified')
    expect(result.candidate.identity.event_start_at).toBe('2026-11-15T00:00:00.000Z')
    expect(assessOpportunityDestination({
      identity: result.candidate.identity,
      evidence: result.candidate.evidence,
      referenceTime: CLOCK,
      maxAgeDays: 30,
      content: result.candidate.identity.audience_description,
    })).toMatchObject({ status: 'pass', newestObservation: '2026-11-15T00:00:00.000Z' })
  })

  it('does not harvest geography from a passing mention of the market (H2)', async () => {
    const result = await validateOpportunityDestination(candidate('https://brokerage.example/education'), {
      fetchImpl: async () => new Response(`
        <html><head><title>Homebuyer education</title></head><body><main>
          <p>Serving Austin, Dallas, Houston and Phoenix homeowners nationwide.</p>
          <p>Register for our free homebuyer webinar and join thousands of attendees.</p>
        </main></body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } }),
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('verified')
    expect(result.candidate.identity.location ?? null).toBeNull()
    // "Register" and "join" are marketing copy, not participation rules.
    expect(result.candidate.identity.participation_rules_status).toBe('unverified')
  })

  it('treats a redirect to the site root as an unavailable destination and keeps the requested URL (H1)', async () => {
    const requested = 'https://www.meetup.com/austin-buyers/events/123456/'
    const result = await validateOpportunityDestination(candidate(requested), {
      fetchImpl: async () => {
        const response = new Response('<html><body><main>Find your people on Meetup.</main></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
        Object.defineProperty(response, 'url', { value: 'https://www.meetup.com/' })
        return response
      },
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.candidate.identity.destination_validation_status).toBe('unavailable')
    expect(result.candidate.identity.urls).toEqual([requested])
    expect(result.candidate.evidence.at(-1)?.detail).toMatchObject({
      destination_final_url: 'https://meetup.com',
      redirect_outcome: 'materially_different_destination',
    })
  })

  it('treats a 200 soft-404 or ended-event page as unavailable (H1)', async () => {
    const result = await validateOpportunityDestination(candidate('https://events.example/ended-workshop'), {
      fetchImpl: async () => new Response(`
        <html><head><title>Homebuyer Workshop</title></head><body><main>
          <p>Register to attend the Austin homebuyer workshop.</p>
          <p>Residents may attend and bring questions about buying in Austin, Texas.</p>
          <p>Sorry, this event has ended and registration is closed.</p>
        </main></body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } }),
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('unavailable')
    expect(assessOpportunityDestination({
      identity: result.candidate.identity,
      evidence: result.candidate.evidence,
      referenceTime: CLOCK,
      maxAgeDays: 30,
    })).toMatchObject({ status: 'fail', issues: expect.arrayContaining(['destination_inactive']) })
  })

  it('treats a 200 login wall as approval_required, never verified public (H1)', async () => {
    const result = await validateOpportunityDestination(candidate('https://neighbors.example/post/42'), {
      fetchImpl: async () => new Response(`
        <html><head><title>Neighborhood post</title></head><body><main>
          <p>Join to see the discussion and register for neighborhood meetings in Austin, Texas.</p>
          <p>Log in to see this post.</p>
        </main></body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } }),
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('unknown')
    expect(result.candidate.identity).toMatchObject({
      access_type: 'approval_required',
      destination_validation_status: 'unknown',
    })
    expect(assessOpportunityDestination({
      identity: result.candidate.identity,
      evidence: result.candidate.evidence,
      referenceTime: CLOCK,
      maxAgeDays: 30,
    }).status).toBe('fail')
  })

  it('records a same-page redirect target as evidence without overwriting identity.urls (H1)', async () => {
    const requested = 'https://windsorpark.example/meetings'
    const result = await validateOpportunityDestination(candidate(requested), {
      fetchImpl: async () => {
        const response = new Response(`
          <html><head><title>Windsor Park Neighborhood Association</title></head><body><main>
            <p>Public neighborhood association meetings are held in Austin, Texas on the second Saturday.</p>
            <p>Residents may attend the meeting and register for community updates.</p>
          </main></body></html>
        `, { status: 200, headers: { 'content-type': 'text/html' } })
        Object.defineProperty(response, 'url', { value: 'https://windsorpark.example/meetings/?ref=nav' })
        return response
      },
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('verified')
    expect(result.candidate.identity.urls).toEqual([requested])
    expect(result.candidate.evidence.at(-1)?.detail).toMatchObject({ destination_final_url: requested })
  })

  it('marks a confirmed missing destination unavailable', async () => {
    const result = await validateOpportunityDestination(candidate('https://events.example/expired'), {
      fetchImpl: async () => new Response('Not found', { status: 404 }),
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.candidate.identity).toMatchObject({
      access_type: 'unknown',
      destination_validation_status: 'unavailable',
      destination_http_status: 404,
    })
    expect(assessOpportunityDestination({
      identity: result.candidate.identity,
      evidence: result.candidate.evidence,
      referenceTime: CLOCK,
      maxAgeDays: 30,
    })).toMatchObject({
      status: 'fail',
      issues: expect.arrayContaining(['destination_inactive']),
    })
  })

  it('blocks sensitive targeting discovered only on the destination page', async () => {
    const result = await validateOpportunityDestination(candidate('https://community.example/housing'), {
      fetchImpl: async () => new Response(
        '<main>Join this housing group for people facing foreclosure and medical debt.</main>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('blocked')
    expect(result.candidate.identity.destination_validation_status).toBe('blocked')
    expect(result.candidate.identity.audience_description).not.toContain('foreclosure')
  })

  it('blocks sensitive material outside the retained relevant excerpt', async () => {
    const generic = Array.from({ length: 10 }, (_, index) =>
      `<p>Public neighborhood meeting ${index + 1} includes housing updates and community participation.</p>`,
    ).join('')
    const result = await validateOpportunityDestination(candidate('https://community.example/housing'), {
      fetchImpl: async () => new Response(
        `<main>${generic}<p>This group targets homeowners facing foreclosure.</p></main>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('blocked')
    expect(result.candidate.identity.audience_description).not.toContain('foreclosure')
  })

  it('fails closed when a destination exceeds the retained body ceiling', async () => {
    const result = await validateOpportunityDestination(candidate('https://community.example/oversized'), {
      fetchImpl: async () => new Response('small', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-length': '300001',
        },
      }),
      now: () => CLOCK,
    })

    expect(result.outcome).toBe('unknown')
    expect(result.candidate.identity).toMatchObject({
      access_type: 'unknown',
      destination_validation_status: 'unknown',
    })
  })
})
