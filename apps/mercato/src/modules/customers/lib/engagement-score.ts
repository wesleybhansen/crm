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
      tenant_id: tenantId,
      event_type: eventType,
      points,
      metadata: metadata ? JSON.stringify(metadata) : null,
      created_at: new Date(),
    })

    // Atomic upsert keyed on the unique contact_id index. Doing the increment
    // in SQL (GREATEST(0, score + points)) instead of read-modify-write means
    // concurrent events (open + submit + pay near-simultaneously) can't clobber
    // each other's points. previousScore is derived for the threshold event.
    const [row] = await knex('contact_engagement_scores')
      .insert({
        id: require('crypto').randomUUID(),
        tenant_id: tenantId,
        organization_id: orgId,
        contact_id: contactId,
        score: Math.max(0, points),
        last_activity_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict('contact_id')
      .merge({
        score: knex.raw('GREATEST(0, contact_engagement_scores.score + ?)', [points]),
        last_activity_at: new Date(),
        updated_at: new Date(),
      })
      .returning(['score'])
    newScore = Number(row?.score) || 0
    previousScore = Math.max(0, newScore - points)

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
