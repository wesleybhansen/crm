import type { Knex } from 'knex'
import { cookies } from 'next/headers'
import crypto from 'crypto'

export async function attributeReferral(
  knex: Knex,
  orgId: string,
  tenantId: string,
  contactEmail: string,
  conversionValue?: number,
  affiliateCode?: string,
): Promise<void> {
  try {
    // Get affiliate code from cookie or param
    let code = affiliateCode
    if (!code) {
      try {
        const cookieStore = await cookies()
        code = cookieStore.get('affiliate_ref')?.value
      } catch {
        // cookies() may not be available in all contexts
      }
    }

    if (!code) return

    // Look up the affiliate
    const affiliate = await knex('affiliates')
      .where('affiliate_code', code)
      .where('organization_id', orgId)
      .where('status', 'active')
      .first()

    if (!affiliate) return

    // Check if we already have a referral for this email from this affiliate
    const existingReferral = await knex('affiliate_referrals')
      .where('affiliate_id', affiliate.id)
      .where('referred_email', contactEmail)
      .first()

    if (existingReferral) {
      // If already referred but not converted and we now have a conversion value, update it
      if (!existingReferral.converted && conversionValue) {
        const commissionAmount = affiliate.commission_type === 'percentage'
          ? (conversionValue * Number(affiliate.commission_rate)) / 100
          : Number(affiliate.commission_rate)

        await knex('affiliate_referrals')
          .where('id', existingReferral.id)
          .update({
            converted: true,
            conversion_value: conversionValue,
            commission_amount: commissionAmount,
            converted_at: new Date(),
          })

        await knex('affiliates')
          .where('id', affiliate.id)
          .increment('total_conversions', 1)
          .increment('total_earned', commissionAmount)
          .update({ updated_at: new Date() })
      }
      return
    }

    // Find the contact by email
    const contact = await knex('customer_entities')
      .where('primary_email', contactEmail)
      .where('organization_id', orgId)
      .whereNull('deleted_at')
      .first()

    // Calculate commission if conversion value provided
    let commissionAmount: number | null = null
    const converted = Boolean(conversionValue)
    if (conversionValue) {
      commissionAmount = affiliate.commission_type === 'percentage'
        ? (conversionValue * Number(affiliate.commission_rate)) / 100
        : Number(affiliate.commission_rate)
    }

    // Create referral record
    await knex('affiliate_referrals').insert({
      id: crypto.randomUUID(),
      affiliate_id: affiliate.id,
      referred_contact_id: contact?.id || null,
      referred_email: contactEmail,
      referral_source: 'cookie',
      converted,
      conversion_value: conversionValue || null,
      commission_amount: commissionAmount,
      referred_at: new Date(),
      converted_at: converted ? new Date() : null,
    })

    // Update affiliate stats
    const statUpdates: Record<string, unknown> = { updated_at: new Date() }
    if (converted && commissionAmount) {
      await knex('affiliates')
        .where('id', affiliate.id)
        .increment('total_conversions', 1)
        .increment('total_earned', commissionAmount)
        .update(statUpdates)
    }
  } catch (error) {
    console.error('[affiliates.attribute] failed', error)
    // Non-blocking — don't throw
  }
}
