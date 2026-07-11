import type { Knex } from 'knex'
import { computeCommission } from './commission'

// Deal-win affiliate attribution.
//
// When a deal transitions to WON for a contact that was referred by an
// affiliate but never converted (no purchase through Stripe), the referral is
// converted here with the deal value as the conversion value. Commission uses
// the same tier-aware computation as checkout conversions.
//
// Idempotent: only unconverted referrals are touched, so calling this again
// for the same deal/contact is a no-op.
export async function attributeDealWin(
  knex: Knex,
  orgId: string,
  tenantId: string | null,
  opts: { contactId?: string | null; email?: string | null; dealValue: number },
): Promise<boolean> {
  try {
    const { contactId, email, dealValue } = opts
    if (!contactId && !email) return false
    if (!Number.isFinite(dealValue) || dealValue <= 0) return false

    // Find the most recent unconverted referral for this contact/email,
    // scoped to affiliates in this org.
    let query = knex('affiliate_referrals as r')
      .join('affiliates as a', 'r.affiliate_id', 'a.id')
      .where('a.organization_id', orgId)
      .where('r.converted', false)
      .orderBy('r.referred_at', 'desc')
      .select('r.*')

    query = query.where((qb) => {
      if (contactId) qb.orWhere('r.referred_contact_id', contactId)
      if (email) qb.orWhereRaw('lower(r.referred_email) = ?', [email.trim().toLowerCase()])
    })

    const referral = await query.first()
    if (!referral) return false

    const affiliate = await knex('affiliates')
      .where('id', referral.affiliate_id)
      .where('organization_id', orgId)
      .first()
    if (!affiliate || affiliate.status !== 'active') return false

    const campaign = affiliate.campaign_id
      ? await knex('affiliate_campaigns').where('id', affiliate.campaign_id).first()
      : null

    // Tier is picked from total_conversions BEFORE this conversion.
    const { amount: commissionAmount } = computeCommission(dealValue, affiliate, campaign)

    // Guard against a concurrent conversion of the same referral: only the
    // update that actually flips converted from false wins.
    const updated = await knex('affiliate_referrals')
      .where('id', referral.id)
      .where('converted', false)
      .update({
        converted: true,
        conversion_value: dealValue,
        commission_amount: commissionAmount,
        converted_at: new Date(),
      })
    if (!updated) return false

    await knex('affiliates')
      .where('id', affiliate.id)
      .where('organization_id', orgId)
      .update({
        total_conversions: knex.raw('total_conversions + 1'),
        total_earned: knex.raw('total_earned + ?', [commissionAmount]),
        updated_at: new Date(),
      })
    return true
  } catch (err) {
    console.error('[affiliates.deal-attribution] failed (non-fatal):', err)
      return false
  }
}
