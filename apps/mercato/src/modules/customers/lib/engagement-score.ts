/**
 * Contact engagement scoring service.
 * Call trackEngagement() from any event handler to update a contact's score.
 */

const SCORE_POINTS: Record<string, number> = {
  email_opened: 1,
  email_clicked: 3,
  form_submitted: 5,
  booking_created: 5,
  invoice_paid: 10,
  deal_created: 3,
  course_enrolled: 5,
  sms_received: 2,
  email_unsubscribed: -5,
  // Decay events (called by periodic cleanup)
  no_activity_30d: -3,
}

export async function trackEngagement(
  knex: any,
  orgId: string,
  tenantId: string,
  contactId: string,
  eventType: string,
  metadata?: any,
  container?: any,
) {
  const points = SCORE_POINTS[eventType]
  if (points === undefined) return

  let previousScore = 0
  let newScore = 0

  try {
    // Log the event
    await knex('engagement_events').insert({
      id: require('crypto').randomUUID(),
      contact_id: contactId,
      organization_id: orgId,
      event_type: eventType,
      points,
      metadata: metadata ? JSON.stringify(metadata) : null,
      created_at: new Date(),
    })

    // Upsert score
    const existing = await knex('contact_engagement_scores')
      .where('contact_id', contactId)
      .first()

    if (existing) {
      previousScore = Number(existing.score) || 0
      newScore = Math.max(0, previousScore + points)
      await knex('contact_engagement_scores')
        .where('contact_id', contactId)
        .update({
          score: newScore,
          last_activity_at: new Date(),
          updated_at: new Date(),
        })
    } else {
      previousScore = 0
      newScore = Math.max(0, points)
      await knex('contact_engagement_scores').insert({
        id: require('crypto').randomUUID(),
        tenant_id: tenantId,
        organization_id: orgId,
        contact_id: contactId,
        score: newScore,
        last_activity_at: new Date(),
        updated_at: new Date(),
      })
    }

    // Emit score_updated event so consumers (e.g. pipeline automation
    // threshold rules) can react. Includes previousScore so consumers can
    // detect threshold crossings rather than firing on every score change.
    if (container && previousScore !== newScore) {
      try {
        const bus = container.resolve('eventBus') as any
        if (bus?.emitEvent) {
          await bus.emitEvent('customers.engagement.score_updated', {
            contactId,
            organizationId: orgId,
            tenantId,
            score: newScore,
            previousScore,
            points,
            eventType,
          }, { persistent: true })
        }
      } catch {}
    }
  } catch (err) {
    console.error('[engagement.score] Failed to track:', err)
  }
}

export { SCORE_POINTS }
