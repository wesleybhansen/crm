import { matchesSequenceTrigger, matchesTriggerConfig, slugifyTag, sourceMatches, tagTriggerMatches } from '../automation-trigger-match'

const TAG_ID = '3f0c2a1e-7b7d-4a52-9d51-6c1f0f8e2b11'
// What /api/crm-contact-tags now reports when a tag is assigned.
const vipEvent = { contactId: 'c-1', tagId: TAG_ID, tagSlug: 'vip-client', tagName: 'VIP Client' }

describe('tag triggers', () => {
  it('the builder picks a tag by id (saved as tagSlug) and it fires for that tag', () => {
    // Before the fix this compared the id with the slug and never matched.
    expect(matchesTriggerConfig('tag_added', { tagSlug: TAG_ID }, vipEvent)).toBe(true)
    expect(matchesTriggerConfig('tag_removed', { tagSlug: TAG_ID }, vipEvent)).toBe(true)
  })

  it('recipes and older rules that saved the slug, and AI rules that saved the label, still match', () => {
    expect(tagTriggerMatches({ tagSlug: 'vip-client' }, vipEvent)).toBe(true)
    expect(tagTriggerMatches({ tagSlug: 'VIP Client' }, vipEvent)).toBe(true)
    expect(tagTriggerMatches({ tagName: 'vip client' }, vipEvent)).toBe(true)
    expect(tagTriggerMatches({ tagId: TAG_ID.toUpperCase() }, vipEvent)).toBe(true)
  })

  it('a different tag does not match, and an empty filter matches every tag', () => {
    expect(tagTriggerMatches({ tagSlug: '0b7d1f7c-0000-4000-8000-000000000000' }, vipEvent)).toBe(false)
    expect(tagTriggerMatches({ tagSlug: 'hot-lead' }, vipEvent)).toBe(false)
    expect(tagTriggerMatches({ tagSlug: '' }, vipEvent)).toBe(true)
    expect(matchesTriggerConfig('tag_added', {}, vipEvent)).toBe(true)
  })

  it('an id-configured trigger does not match an event that carries only another tag slug', () => {
    expect(tagTriggerMatches({ tagSlug: TAG_ID }, { tagSlug: 'vip-client', tagName: 'VIP Client' })).toBe(false)
  })

  it('sequences use the same matcher (the Sequences editor also saves the tag id)', () => {
    expect(matchesSequenceTrigger('tag_added', { tagSlug: TAG_ID }, vipEvent)).toBe(true)
    expect(matchesSequenceTrigger('tag_added', { tagSlug: 'new-lead' }, vipEvent)).toBe(false)
    expect(matchesSequenceTrigger('tag_added', { tagSlug: 'new-lead' }, { tagSlug: 'new-lead' })).toBe(true)
  })

  it('slugs are built like the tag routes build them', () => {
    expect(slugifyTag('  VIP Client! ')).toBe('vip-client-')
  })
})

describe('other trigger filters', () => {
  it('contact source matches case-insensitively and by category', () => {
    expect(sourceMatches('manual', 'manual')).toBe(true)
    expect(sourceMatches('landing_page', 'landing_page:google')).toBe(true)
    expect(sourceMatches('Import', 'import')).toBe(true)
    expect(sourceMatches('form', 'landing_page')).toBe(false)
    expect(sourceMatches('form', null)).toBe(false)
    expect(sourceMatches('', 'anything')).toBe(true)
    expect(matchesTriggerConfig('contact_created', { source: 'manual' }, { source: 'manual' })).toBe(true)
    expect(matchesTriggerConfig('contact_created', { source: 'form' }, { source: 'manual' })).toBe(false)
  })

  it('a sequence limited to one booking page only enrolls bookings on that page', () => {
    expect(matchesSequenceTrigger('booking_created', { bookingPageId: 'bp-1' }, { bookingPageId: 'bp-1' })).toBe(true)
    expect(matchesSequenceTrigger('booking_created', { bookingPageId: 'bp-1' }, { bookingPageId: 'bp-2' })).toBe(false)
    expect(matchesSequenceTrigger('booking_created', {}, { bookingPageId: 'bp-2' })).toBe(true)
  })

  it('stage filters compare names case-insensitively', () => {
    expect(matchesTriggerConfig('stage_change', { toStage: 'Offer' }, { toStage: 'offer' })).toBe(true)
    expect(matchesSequenceTrigger('deal_stage_changed', { stage: 'Offer' }, { stage: 'offer' })).toBe(true)
    expect(matchesSequenceTrigger('deal_stage_changed', { stage: 'Offer' }, { stage: 'Closed' })).toBe(false)
  })
})
