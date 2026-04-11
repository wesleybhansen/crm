// ORM-SKIP: complex multi-table logic or public/webhook endpoint
export const metadata = { path: '/affiliates/signup', GET: { requireAuth: true }, POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

function generateAffiliateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const bytes = crypto.randomBytes(8)
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length]
  return code
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const campaignId = url.searchParams.get('campaign')
  const success = url.searchParams.get('success')
  const dashboardCode = url.searchParams.get('code')

  // Load campaign info if provided
  let campaignName = 'Our Affiliate Program'
  let campaignDesc = ''
  let commissionRate = '10'
  let commissionType = 'percentage'
  let productNames: string[] = []
  let discount = '0'
  let discountType = 'percentage'
  let termsText = ''

  if (campaignId) {
    try {
      const container = await createRequestContainer()
      const knex = (container.resolve('em') as EntityManager).getKnex()
      const campaign = await knex('affiliate_campaigns').where('id', campaignId).first()
      if (campaign) {
        campaignName = campaign.name
        campaignDesc = campaign.description || ''
        commissionRate = String(Number(campaign.commission_rate))
        commissionType = campaign.commission_type
        discount = String(Number(campaign.customer_discount))
        discountType = campaign.customer_discount_type
        termsText = campaign.terms_text || ''

        const productIds = typeof campaign.product_ids === 'string' ? JSON.parse(campaign.product_ids) : (campaign.product_ids || [])
        if (productIds.length > 0) {
          const prods = await knex('products').whereIn('id', productIds).select('name', 'price')
          productNames = prods.map((p: any) => `${p.name} ($${Number(p.price).toFixed(2)})`)
        }
      }
    } catch { /* continue with defaults */ }
  }

  const commissionDisplay = commissionType === 'percentage' ? `${commissionRate}%` : `$${Number(commissionRate).toFixed(2)}`
  const discountDisplay = Number(discount) > 0 ? (discountType === 'percentage' ? `${discount}% off` : `$${Number(discount).toFixed(2)} off`) : null

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(campaignName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#f0f0ff 0%,#f8fafc 50%,#faf5ff 100%);color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border-radius:20px;box-shadow:0 1px 3px rgba(0,0,0,.04),0 20px 60px rgba(0,0,0,.07);max-width:520px;width:100%;overflow:hidden}
.hero{background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 50%,#9333ea 100%);padding:44px 36px 36px;color:#fff;text-align:center;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;inset:0;background:url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.05'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")}
.hero .badge{display:inline-block;background:rgba(255,255,255,.2);backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,.15);padding:6px 16px;border-radius:100px;font-size:12px;font-weight:600;letter-spacing:.03em;margin-bottom:16px;position:relative}
.hero h1{font-size:26px;font-weight:700;margin-bottom:10px;letter-spacing:-.02em;position:relative}
.hero p{font-size:14px;opacity:.85;line-height:1.6;max-width:380px;margin:0 auto;position:relative}
.highlights{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:24px 36px 0}
.highlight{background:linear-gradient(135deg,#faf5ff,#f0f0ff);border:1px solid #e8e0f0;border-radius:12px;padding:18px 16px;text-align:center;transition:transform .15s,box-shadow .15s}
.highlight:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(99,102,241,.1)}
.highlight .val{font-size:22px;font-weight:700;color:#6366f1;margin-bottom:2px}
.highlight .lbl{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.perks{padding:24px 36px 0;display:grid;grid-template-columns:1fr 1fr;gap:10px}
.perk{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:#f8fafc;border:1px solid #f1f5f9}
.perk svg{width:18px;height:18px;color:#6366f1;flex-shrink:0}
.perk span{font-size:12px;color:#475569;font-weight:500}
${productNames.length > 0 ? `.products{padding:20px 36px 0}.products h3{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:10px}.products ul{list-style:none;display:flex;flex-wrap:wrap;gap:8px}.products li{background:#f8fafc;border:1px solid #e2e8f0;padding:7px 14px;border-radius:8px;font-size:13px;font-weight:500}` : ''}
.form-area{padding:28px 36px 36px}
.form-area h3{font-size:15px;font-weight:600;margin-bottom:16px;color:#1e293b}
.field{margin-bottom:14px}
.field label{display:block;font-size:12px;font-weight:600;margin-bottom:5px;color:#475569;text-transform:uppercase;letter-spacing:.03em}
.field input{width:100%;padding:11px 14px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:14px;font-family:inherit;transition:border-color .2s,box-shadow .2s;background:#fff}
.field input:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.12)}
.field input::placeholder{color:#cbd5e1}
.submit{width:100%;padding:13px;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s;letter-spacing:.01em}
.submit:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(99,102,241,.35)}
.submit:active{transform:translateY(0)}
.submit:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.error{background:#fef2f2;border:1px solid #fecaca;color:#dc2626;padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:16px;display:none}
.success-area{padding:52px 36px;text-align:center}
.success-area .icon{width:68px;height:68px;background:linear-gradient(135deg,#dcfce7,#bbf7d0);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}
.success-area .icon svg{width:34px;height:34px;color:#16a34a}
.success-area h2{font-size:24px;font-weight:700;margin-bottom:10px}
.success-area p{color:#64748b;font-size:14px;line-height:1.6;max-width:360px;margin:0 auto}
.success-area .dash-link{display:inline-block;margin-top:24px;padding:12px 28px;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px;transition:all .2s}
.success-area .dash-link:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(99,102,241,.35)}
.fine{text-align:center;font-size:11px;color:#94a3b8;margin-top:16px}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.card{animation:fadeUp .5s ease}
</style></head><body>
<div class="card">
${success ? `
<div class="success-area">
  <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg></div>
  <h2>${dashboardCode ? 'You\'re approved!' : 'Application received!'}</h2>
  <p>${dashboardCode ? 'Your affiliate account is active. Visit your dashboard to get your referral link and track your commissions.' : 'We\'ll review your application and get back to you shortly. Check your email for updates.'}</p>
  ${dashboardCode ? `<a class="dash-link" href="${esc(url.origin)}/api/affiliates/dashboard/${esc(dashboardCode)}">Open My Dashboard</a>` : ''}
</div>` : `
<div class="hero">
  <div class="badge">Affiliate Program</div>
  <h1>${esc(campaignName)}</h1>
  <p>${campaignDesc ? esc(campaignDesc) : 'Earn commissions by referring customers. Share your unique link or discount code and get paid for every sale.'}</p>
</div>
<div class="highlights">
  <div class="highlight"><div class="val">${esc(commissionDisplay)}</div><div class="lbl">Your Commission</div></div>
  <div class="highlight"><div class="val">${discountDisplay ? esc(discountDisplay) : 'Unique Link'}</div><div class="lbl">${discountDisplay ? 'Customer Discount' : 'Tracking'}</div></div>
</div>
<div class="perks">
  <div class="perk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.193-9.193a4.5 4.5 0 016.364 6.364l-4.5 4.5a4.5 4.5 0 01-7.244-1.242"/></svg><span>Unique referral link</span></div>
  <div class="perk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/></svg><span>Real-time dashboard</span></div>
  <div class="perk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>Automatic tracking</span></div>
  <div class="perk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z"/></svg><span>Regular payouts</span></div>
</div>
${productNames.length > 0 ? `<div class="products"><h3>Products You'll Promote</h3><ul>${productNames.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
<div class="form-area">
  <h3>Apply Now</h3>
  <div class="error" id="err"></div>
  <form id="f" novalidate>
    <input type="hidden" name="campaignId" value="${esc(campaignId || '')}" />
    <div class="field"><label>Full Name *</label><input type="text" name="name" required placeholder="Jane Smith" /></div>
    <div class="field"><label>Email *</label><input type="email" name="email" required placeholder="jane@example.com" /></div>
    <div class="field"><label>Phone</label><input type="tel" name="phone" placeholder="+1 (555) 000-0000" /></div>
    <div class="field"><label>Website or Social</label><input type="url" name="website" placeholder="https://yoursite.com" /></div>
    <div class="field"><label>How will you promote?</label><input type="text" name="promotion_method" placeholder="Blog, YouTube, email list..." /></div>
    ${termsText ? `
    <div style="margin-bottom:16px">
      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
        <input type="checkbox" name="acceptedTerms" value="yes" required style="margin-top:3px;accent-color:#6366f1" />
        <span style="font-size:13px;color:#374151">I have read and agree to these <a href="#terms" onclick="document.getElementById('termsBox').style.display=document.getElementById('termsBox').style.display==='none'?'block':'none';return false" style="color:#6366f1;text-decoration:underline;font-weight:500">terms and conditions</a> <span style="color:#dc2626">*</span></span>
      </label>
      <div id="termsBox" style="display:none;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;max-height:200px;overflow-y:auto;font-size:13px;line-height:1.6;color:#475569;margin-top:10px;white-space:pre-wrap">${esc(termsText)}</div>
    </div>` : ''}
    <button type="submit" class="submit" id="btn">Apply Now</button>
  </form>
  ${!termsText ? '<p class="fine">Commission payments are made after a review period.</p>' : ''}
</div>`}
</div>
<script>
(function(){var f=document.getElementById('f');if(!f)return;
f.addEventListener('submit',function(e){e.preventDefault();
var b=document.getElementById('btn'),er=document.getElementById('err');er.style.display='none';
var d=Object.fromEntries(new FormData(f));if(!d.name||!d.email){er.textContent='Name and email are required.';er.style.display='block';return}
var tc=f.querySelector('input[name="acceptedTerms"]');if(tc&&!tc.checked){er.textContent='You must accept the terms and conditions.';er.style.display='block';return}
b.disabled=true;b.textContent='Submitting...';
fetch(window.location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})
.then(function(r){return r.json()}).then(function(r){
if(r.ok){var u=window.location.pathname+'?success=1';if(r.data&&r.data.dashboardCode)u+='&code='+r.data.dashboardCode;if(d.campaignId)u+='&campaign='+d.campaignId;window.location.href=u}
else{er.textContent=r.error||'Something went wrong.';er.style.display='block';b.disabled=false;b.textContent='Apply Now'}
}).catch(function(){er.textContent='Network error.';er.style.display='block';b.disabled=false;b.textContent='Apply Now'})})})();
</script></body></html>`

  return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { name, email, phone, website, promotion_method, campaignId, acceptedTerms } = body

    if (!name?.trim() || !email?.trim()) return NextResponse.json({ ok: false, error: 'Name and email are required' }, { status: 400 })

    // Get org from campaign or fallback
    let organizationId: string | null = null
    let tenantId: string | null = null
    let campaign: any = null

    if (campaignId) {
      campaign = await knex('affiliate_campaigns').where('id', campaignId).first()
      if (campaign) { organizationId = campaign.organization_id; tenantId = campaign.tenant_id }
    }
    if (!organizationId || !tenantId) return NextResponse.json({ ok: false, error: 'A valid campaign is required to sign up' }, { status: 400 })

    // Require terms acceptance if campaign has terms
    if (campaign?.terms_text && acceptedTerms !== 'yes' && acceptedTerms !== true) {
      return NextResponse.json({ ok: false, error: 'You must accept the terms and conditions' }, { status: 400 })
    }

    // Check duplicate
    const existing = await knex('affiliates').where('email', email.trim()).where('organization_id', organizationId).first()
    if (existing) return NextResponse.json({ ok: false, error: 'An affiliate with this email already exists' }, { status: 409 })

    // Generate code
    let affiliateCode = generateAffiliateCode()
    let attempts = 0
    while (attempts < 10) {
      const dup = await knex('affiliates').where('organization_id', organizationId).where('affiliate_code', affiliateCode).first()
      if (!dup) break; affiliateCode = generateAffiliateCode(); attempts++
    }

    // Create or link CRM contact
    let contact = await knex('customer_entities').where('primary_email', email.trim()).where('organization_id', organizationId).whereNull('deleted_at').first()

    if (!contact) {
      const contactId = crypto.randomUUID()
      const nameParts = name.trim().split(/\s+/)
      const firstName = nameParts[0] || ''
      const lastName = nameParts.slice(1).join(' ') || ''

      await knex('customer_entities').insert({
        id: contactId, tenant_id: tenantId, organization_id: organizationId,
        kind: 'person', display_name: name.trim(), primary_email: email.trim(),
        primary_phone: phone?.trim() || null,
        source: 'affiliate', status: 'active', lifecycle_stage: 'partner',
        created_at: new Date(), updated_at: new Date(),
      }).catch(() => {})

      await knex('customer_people').insert({
        id: crypto.randomUUID(), tenant_id: tenantId, organization_id: organizationId,
        entity_id: contactId, first_name: firstName, last_name: lastName,
        created_at: new Date(), updated_at: new Date(),
      }).catch(() => {})

      contact = { id: contactId }
    }

    // Tag as "Affiliate"
    if (contact?.id) {
      try {
        let tag = await knex('customer_tags').where('label', 'Affiliate').where('organization_id', organizationId).first()
        if (!tag) {
          const tagId = crypto.randomUUID()
          await knex('customer_tags').insert({ id: tagId, tenant_id: tenantId, organization_id: organizationId, label: 'Affiliate', slug: 'affiliate', created_at: new Date(), updated_at: new Date() })
          tag = { id: tagId }
        }
        const existingLink = await knex('customer_entity_tags').where('entity_id', contact.id).where('tag_id', tag.id).first()
        if (!existingLink) {
          await knex('customer_entity_tags').insert({ id: crypto.randomUUID(), entity_id: contact.id, tag_id: tag.id, created_at: new Date() })
        }
      } catch { /* non-critical */ }
    }

    const isAutoApprove = campaign?.auto_approve ?? false
    const id = crypto.randomUUID()
    const now = new Date()

    await knex('affiliates').insert({
      id, tenant_id: tenantId, organization_id: organizationId,
      contact_id: contact?.id || null, name: name.trim(), email: email.trim(),
      affiliate_code: affiliateCode,
      commission_rate: campaign ? Number(campaign.commission_rate) : 10,
      commission_type: campaign?.commission_type || 'percentage',
      campaign_id: campaignId || null,
      website: website?.trim() || null,
      promotion_method: promotion_method?.trim() || null,
      accepted_terms: acceptedTerms === 'yes' || acceptedTerms === true,
      accepted_terms_at: (acceptedTerms === 'yes' || acceptedTerms === true) ? now : null,
      status: isAutoApprove ? 'active' : 'pending',
      approved_at: isAutoApprove ? now : null,
      total_referrals: 0, total_conversions: 0, total_earned: 0,
      created_at: now, updated_at: now,
    })

    // If auto-approved and campaign has Stripe coupon, create promo code
    let dashboardCode: string | null = null
    if (isAutoApprove) {
      dashboardCode = affiliateCode
      if (campaign?.stripe_coupon_id) {
        const org = await knex('organizations').where('id', organizationId).first()
        const stripeAccountId = org?.stripe_account_id
        if (stripeAccountId && process.env.STRIPE_SECRET_KEY) {
          try {
            const Stripe = (await import('stripe')).default
            const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' as any })
            const promo = await stripe.promotionCodes.create({
              coupon: campaign.stripe_coupon_id,
              code: affiliateCode,
              metadata: { affiliate_id: id, campaign_id: campaignId, organization_id: organizationId },
            }, { stripeAccount: stripeAccountId })
            await knex('affiliates').where('id', id).update({ stripe_promo_code_id: promo.id, stripe_promo_code: promo.code })
          } catch (err) {
            console.error('[affiliates.signup] Stripe promo creation failed', err)
            await knex('affiliates').where('id', id).update({ stripe_promo_code: affiliateCode })
          }
        }
      }
    }

    // Send welcome email for auto-approved affiliates
    if (isAutoApprove && organizationId && tenantId) {
      try {
        const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        const refLinkUrl = `${origin}/api/affiliates/ref/${affiliateCode}`
        const dashLinkUrl = `${origin}/api/affiliates/dashboard/${affiliateCode}`
        const promoCode = affiliateCode
        const rate = campaign ? Number(campaign.commission_rate) : 10
        const rateType = campaign?.commission_type || 'percentage'

        const emailHtml = `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
            <div style="text-align:center;padding:32px 0 24px">
              <div style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;padding:10px 20px;border-radius:10px;font-size:14px;font-weight:600">Welcome, Affiliate!</div>
            </div>
            <h2 style="margin:0 0 8px;font-size:20px">You're approved, ${name.trim()}!</h2>
            <p style="color:#64748b;font-size:14px;line-height:1.6;margin-bottom:24px">Your affiliate account is active. Start earning by sharing your referral link or discount code.</p>
            <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:16px">
              <p style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Your Referral Link</p>
              <p style="font-size:14px;word-break:break-all;margin:0;background:#fff;padding:10px 14px;border-radius:8px;border:1px solid #e2e8f0">${refLinkUrl}</p>
            </div>
            <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:16px">
              <p style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Your Discount Code</p>
              <p style="font-size:22px;font-weight:700;letter-spacing:.1em;margin:0;color:#6366f1">${promoCode}</p>
            </div>
            <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:24px">
              <p style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Commission</p>
              <p style="font-size:18px;font-weight:700;margin:0">${rateType === 'percentage' ? rate + '%' : '$' + Number(rate).toFixed(2)} per sale</p>
            </div>
            <div style="text-align:center"><a href="${dashLinkUrl}" style="display:inline-block;background:#6366f1;color:white;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">View Your Dashboard</a></div>
          </div>`

        const { sendEmailByPurpose } = await import('@/modules/email/lib/email-router')
        await sendEmailByPurpose(knex, organizationId, tenantId, 'transactional', {
          to: email.trim(),
          subject: `You're approved! Here's your affiliate link and code`,
          htmlBody: emailHtml,
        }).catch((err: unknown) => console.error('[affiliates.signup] welcome email failed:', err))
      } catch (emailErr) {
        console.error('[affiliates.signup] welcome email error:', emailErr)
      }
    }

    return NextResponse.json({ ok: true, data: { id, dashboardCode } }, { status: 201 })
  } catch (error) {
    console.error('[affiliates.signup.POST] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to process application' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Affiliates', summary: 'Affiliate self-signup',
  methods: { GET: { summary: 'Render signup page', tags: ['Affiliates'] }, POST: { summary: 'Process application', tags: ['Affiliates'] } },
}
