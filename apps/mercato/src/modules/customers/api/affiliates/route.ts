export const metadata = { path: '/affiliates', GET: { requireAuth: true }, POST: { requireAuth: true }, PUT: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'
import Stripe from 'stripe'

function generateAffiliateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const bytes = crypto.randomBytes(8)
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length]
  return code
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const status = url.searchParams.get('status')
    const campaignId = url.searchParams.get('campaignId')

    let query = knex('affiliates')
      .where('affiliates.organization_id', auth.orgId)
      .orderBy('affiliates.created_at', 'desc')

    if (status) query = query.where('affiliates.status', status)
    if (campaignId) query = query.where('affiliates.campaign_id', campaignId)

    // Join campaign name
    const affiliates = await query
      .leftJoin('affiliate_campaigns', 'affiliates.campaign_id', 'affiliate_campaigns.id')
      .select('affiliates.*', 'affiliate_campaigns.name as campaign_name')

    return NextResponse.json({ ok: true, data: affiliates })
  } catch (error) {
    console.error('[affiliates.GET] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to load affiliates' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { name, email, phone, commissionRate, commissionType, campaignId } = body

    if (!name || !email) return NextResponse.json({ ok: false, error: 'Name and email are required' }, { status: 400 })

    // Check duplicate
    const existing = await knex('affiliates')
      .where('email', email.trim())
      .where('organization_id', auth.orgId)
      .first()
    if (existing) return NextResponse.json({ ok: false, error: 'An affiliate with this email already exists' }, { status: 409 })

    // Generate unique code
    let affiliateCode = generateAffiliateCode()
    let attempts = 0
    while (attempts < 10) {
      const dup = await knex('affiliates').where('organization_id', auth.orgId).where('affiliate_code', affiliateCode).first()
      if (!dup) break
      affiliateCode = generateAffiliateCode()
      attempts++
    }

    // Create or link CRM contact
    let contact = await knex('customer_entities')
      .where('primary_email', email.trim())
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!contact) {
      const contactId = crypto.randomUUID()
      const nameParts = name.trim().split(/\s+/)
      const firstName = nameParts[0] || ''
      const lastName = nameParts.slice(1).join(' ') || ''

      await knex('customer_entities').insert({
        id: contactId,
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        kind: 'person',
        display_name: name.trim(),
        primary_email: email.trim(),
        primary_phone: phone?.trim() || null,
        source: 'affiliate',
        status: 'active',
        lifecycle_stage: 'partner',
        created_at: new Date(),
        updated_at: new Date(),
      }).catch(() => {})

      await knex('customer_people').insert({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        entity_id: contactId,
        first_name: firstName,
        last_name: lastName,
        created_at: new Date(),
        updated_at: new Date(),
      }).catch(() => {})

      contact = { id: contactId }
    }

    // Tag as "Affiliate"
    if (contact?.id) {
      try {
        let tag = await knex('customer_tags')
          .where('name', 'Affiliate')
          .where('organization_id', auth.orgId)
          .first()
        if (!tag) {
          const tagId = crypto.randomUUID()
          await knex('customer_tags').insert({
            id: tagId, tenant_id: auth.tenantId, organization_id: auth.orgId,
            name: 'Affiliate', created_at: new Date(), updated_at: new Date(),
          })
          tag = { id: tagId }
        }
        const existingLink = await knex('customer_entity_tags')
          .where('entity_id', contact.id).where('tag_id', tag.id).first()
        if (!existingLink) {
          await knex('customer_entity_tags').insert({
            id: crypto.randomUUID(), entity_id: contact.id, tag_id: tag.id, created_at: new Date(),
          })
        }
      } catch { /* non-critical */ }
    }

    // Get campaign defaults if provided
    let campaign = null
    let effectiveRate = Number(commissionRate) || 10
    let effectiveType = commissionType || 'percentage'
    if (campaignId) {
      campaign = await knex('affiliate_campaigns').where('id', campaignId).where('organization_id', auth.orgId).first()
      if (campaign) {
        effectiveRate = Number(campaign.commission_rate)
        effectiveType = campaign.commission_type
      }
    }

    const id = crypto.randomUUID()
    const now = new Date()

    // When admin creates, auto-approve and create Stripe promo code
    let stripePromoCodeId: string | null = null
    let stripePromoCode: string | null = null
    if (campaign?.stripe_coupon_id) {
      const org = await knex('organizations').where('id', auth.orgId).first()
      const stripeAccountId = org?.stripe_account_id
      if (stripeAccountId && process.env.STRIPE_SECRET_KEY) {
        try {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' as any })
          const promo = await stripe.promotionCodes.create({
            coupon: campaign.stripe_coupon_id,
            code: affiliateCode,
            metadata: { affiliate_id: id, campaign_id: campaignId, organization_id: auth.orgId },
          }, { stripeAccount: stripeAccountId })
          stripePromoCodeId = promo.id
          stripePromoCode = promo.code
        } catch (err) {
          console.error('[affiliates] Stripe promo code creation failed', err)
        }
      }
    }

    await knex('affiliates').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      contact_id: contact?.id || null,
      name: name.trim(),
      email: email.trim(),
      affiliate_code: affiliateCode,
      commission_rate: effectiveRate,
      commission_type: effectiveType,
      campaign_id: campaignId || null,
      stripe_promo_code_id: stripePromoCodeId,
      stripe_promo_code: stripePromoCode || affiliateCode,
      status: 'active',
      approved_at: now,
      total_referrals: 0,
      total_conversions: 0,
      total_earned: 0,
      created_at: now,
      updated_at: now,
    })

    // Send welcome email to the new affiliate
    try {
      const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
      const refLinkUrl = `${origin}/api/affiliates/ref/${affiliateCode}`
      const dashLinkUrl = `${origin}/api/affiliates/dashboard/${affiliateCode}`
      const promoCode = stripePromoCode || affiliateCode

      const emailHtml = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
          <div style="text-align:center;padding:32px 0 24px">
            <div style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;padding:10px 20px;border-radius:10px;font-size:14px;font-weight:600">Welcome, Affiliate!</div>
          </div>
          <h2 style="margin:0 0 8px;font-size:20px">You've been added to the affiliate program, ${name}!</h2>
          <p style="color:#64748b;font-size:14px;line-height:1.6;margin-bottom:24px">Start earning commissions by sharing your referral link or discount code with your audience.</p>
          <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:16px">
            <p style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Your Referral Link</p>
            <p style="font-size:14px;word-break:break-all;margin:0;background:#fff;padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0">${refLinkUrl}</p>
          </div>
          <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:16px">
            <p style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Your Discount Code</p>
            <p style="font-size:22px;font-weight:700;letter-spacing:.1em;margin:0;color:#6366f1">${promoCode}</p>
          </div>
          <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:24px">
            <p style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Commission Rate</p>
            <p style="font-size:18px;font-weight:700;margin:0">${effectiveType === 'percentage' ? effectiveRate + '%' : '$' + Number(effectiveRate).toFixed(2)} per sale</p>
          </div>
          <div style="text-align:center;margin-bottom:24px">
            <a href="${dashLinkUrl}" style="display:inline-block;background:#6366f1;color:white;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">View Your Dashboard</a>
          </div>
        </div>`

      const { sendEmailByPurpose } = await import('@/modules/email/lib/email-router')
      await sendEmailByPurpose(knex, auth.orgId, auth.tenantId, 'transactional', {
        to: email.trim(),
        subject: `Welcome to the affiliate program! Here's your link and code`,
        htmlBody: emailHtml,
      }).catch((err: unknown) => console.error('[affiliates] welcome email failed:', err))
    } catch (emailErr) { console.error('[affiliates] welcome email error:', emailErr) }

    return NextResponse.json({ ok: true, data: { id, affiliateCode, stripePromoCode: stripePromoCode || affiliateCode } }, { status: 201 })
  } catch (error) {
    console.error('[affiliates.POST] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to create affiliate' }, { status: 500 })
  }
}

// Approve affiliate (creates Stripe promo code) or update fields
export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const affiliate = await knex('affiliates').where('id', id).where('organization_id', auth.orgId).first()
    if (!affiliate) return NextResponse.json({ ok: false, error: 'Affiliate not found' }, { status: 404 })

    const body = await req.json()
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) updates.name = body.name
    if (body.email !== undefined) updates.email = body.email
    if (body.commissionRate !== undefined) updates.commission_rate = body.commissionRate
    if (body.commissionType !== undefined) updates.commission_type = body.commissionType

    // Handle approval: pending → active
    if (body.status === 'active' && affiliate.status === 'pending') {
      updates.status = 'active'
      updates.approved_at = new Date()

      // Create Stripe promo code on approval if campaign has coupon
      if (affiliate.campaign_id && !affiliate.stripe_promo_code_id) {
        const campaign = await knex('affiliate_campaigns').where('id', affiliate.campaign_id).first()
        if (campaign?.stripe_coupon_id) {
          const org = await knex('organizations').where('id', auth.orgId).first()
          const stripeAccountId = org?.stripe_account_id
          if (stripeAccountId && process.env.STRIPE_SECRET_KEY) {
            try {
              const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' as any })
              const promo = await stripe.promotionCodes.create({
                coupon: campaign.stripe_coupon_id,
                code: affiliate.affiliate_code,
                metadata: { affiliate_id: id, campaign_id: affiliate.campaign_id, organization_id: auth.orgId },
              }, { stripeAccount: stripeAccountId })
              updates.stripe_promo_code_id = promo.id
              updates.stripe_promo_code = promo.code
            } catch (err) {
              console.error('[affiliates.approve] Stripe promo code creation failed', err)
              // Still approve, just without Stripe promo
              updates.stripe_promo_code = affiliate.affiliate_code
            }
          }
        }
      }
    } else if (body.status !== undefined) {
      updates.status = body.status
    }

    await knex('affiliates').where('id', id).update(updates)
    const updated = await knex('affiliates').where('id', id).first()

    // Send approval email
    if (body.status === 'active' && affiliate.status === 'pending' && updated) {
      try {
        const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        const refLink = `${origin}/api/affiliates/ref/${updated.affiliate_code}`
        const dashLink = `${origin}/api/affiliates/dashboard/${updated.affiliate_code}`
        const promoCode = updated.stripe_promo_code || updated.affiliate_code

        const emailHtml = `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
            <div style="text-align:center;padding:32px 0 24px">
              <div style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;padding:10px 20px;border-radius:10px;font-size:14px;font-weight:600">You're Approved!</div>
            </div>
            <h2 style="margin:0 0 8px;font-size:20px">Welcome to the affiliate program, ${updated.name}!</h2>
            <p style="color:#64748b;font-size:14px;line-height:1.6;margin-bottom:24px">Your application has been approved. You can start earning commissions right away by sharing your unique referral link or discount code.</p>

            <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:16px">
              <p style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Your Referral Link</p>
              <p style="font-size:14px;word-break:break-all;margin:0;background:#fff;padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0">${refLink}</p>
            </div>

            <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:16px">
              <p style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Your Discount Code</p>
              <p style="font-size:22px;font-weight:700;letter-spacing:.1em;margin:0;color:#6366f1">${promoCode}</p>
              <p style="font-size:12px;color:#94a3b8;margin:6px 0 0">Share this code with your audience. When they use it at checkout, the sale is attributed to you.</p>
            </div>

            <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:24px">
              <p style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Commission Rate</p>
              <p style="font-size:18px;font-weight:700;margin:0">${updated.commission_type === 'percentage' ? Number(updated.commission_rate).toFixed(0) + '%' : '$' + Number(updated.commission_rate).toFixed(2)} per sale</p>
            </div>

            <div style="text-align:center;margin-bottom:24px">
              <a href="${dashLink}" style="display:inline-block;background:#6366f1;color:white;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">View Your Dashboard</a>
            </div>

            <p style="color:#94a3b8;font-size:12px;text-align:center">Track your referrals, conversions, and commissions anytime from your dashboard.</p>
          </div>`

        const { sendEmailByPurpose } = await import('@/modules/email/lib/email-router')
        await sendEmailByPurpose(knex, auth.orgId, auth.tenantId || '', 'transactional', {
          to: updated.email,
          subject: `You're approved! Here's your affiliate link and code`,
          htmlBody: emailHtml,
        }).catch((err: unknown) => console.error('[affiliates] approval email failed', err))
      } catch (emailErr) {
        console.error('[affiliates] approval email failed (non-blocking)', emailErr)
      }
    }

    return NextResponse.json({ ok: true, data: updated })
  } catch (error) {
    console.error('[affiliates.PUT] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to update affiliate' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    await knex('affiliates').where('id', id).where('organization_id', auth.orgId)
      .update({ status: 'inactive', updated_at: new Date() })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[affiliates.DELETE] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to deactivate affiliate' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Affiliates',
  summary: 'Affiliate management',
  methods: {
    GET: { summary: 'List affiliates', tags: ['Affiliates'] },
    POST: { summary: 'Create affiliate (admin)', tags: ['Affiliates'] },
    PUT: { summary: 'Update/approve affiliate', tags: ['Affiliates'] },
    DELETE: { summary: 'Deactivate affiliate', tags: ['Affiliates'] },
  },
}
