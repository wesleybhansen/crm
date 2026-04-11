export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true } }
export const openApi = { summary: 'templates', methods: {} }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query, queryOne } from '@/lib/db'
import crypto from 'crypto'

type FunnelTemplate = {
  id: string
  name: string
  description: string
  category: string
  steps: Array<{
    stepType: string
    name: string
    templateId?: string
    templateCategory?: string
    pageTitle?: string
    config?: Record<string, any>
  }>
}

const FUNNEL_TEMPLATES: FunnelTemplate[] = [
  {
    id: 'lead-magnet',
    name: 'Lead Magnet Funnel',
    description: 'Capture leads with a free resource. Landing page with email opt-in, then a thank you page with the download link.',
    category: 'Lead Generation',
    steps: [
      { stepType: 'lead_capture', name: 'Opt-In Page', templateId: 'lead-magnet-minimal', templateCategory: 'lead-magnet', pageTitle: 'Free Resource' },
      { stepType: 'thank_you', name: 'Thank You', config: { message: 'Thank you! Check your email for your download link.' } },
    ],
  },
  {
    id: 'consultation',
    name: 'Consultation Funnel',
    description: 'Book free consultations and upsell a premium package. Landing page → Checkout → Upsell → Thank you.',
    category: 'Services',
    steps: [
      { stepType: 'page', name: 'Book a Call', templateId: 'booking-minimal', templateCategory: 'booking', pageTitle: 'Free Consultation' },
      { stepType: 'checkout', name: 'Checkout', config: {} },
      { stepType: 'upsell', name: 'Premium Package', config: { headline: 'Upgrade to Premium', description: 'Get priority access, extended sessions, and a personalized action plan.', accept_button_text: 'Yes! Upgrade Me', decline_button_text: 'No thanks, the basic plan is fine' } },
      { stepType: 'thank_you', name: 'Thank You', config: { message: 'Your booking is confirmed! Check your email for the details.' } },
    ],
  },
  {
    id: 'product-launch',
    name: 'Product Launch Funnel',
    description: 'Sell a product with upsells and downsells. Landing page → Checkout → Upsell → Downsell → Thank you.',
    category: 'E-Commerce',
    steps: [
      { stepType: 'page', name: 'Sales Page', templateId: 'info-product-storefront', templateCategory: 'info-product', pageTitle: 'Product Launch' },
      { stepType: 'checkout', name: 'Checkout', config: {} },
      { stepType: 'upsell', name: 'Premium Bundle', config: { headline: 'Wait! Exclusive Upgrade', description: 'Add the premium bundle with bonus resources, templates, and lifetime updates at a special one-time price.', accept_button_text: 'Yes! Add the Bundle', decline_button_text: "No thanks, I'm good with the basic" } },
      { stepType: 'downsell', name: 'Starter Pack', config: { headline: 'How About Our Starter Pack?', description: 'Not ready for the full bundle? Grab the starter pack with the essential resources at a fraction of the price.', accept_button_text: 'Yes! I want the Starter Pack', decline_button_text: 'No thanks, take me to my purchase' } },
      { stepType: 'thank_you', name: 'Thank You', config: { message: 'Thank you for your purchase! Check your email for access details.' } },
    ],
  },
  {
    id: 'webinar',
    name: 'Webinar Funnel',
    description: 'Register attendees and convert to buyers. Registration → Confirmation → Replay → Checkout → Thank you.',
    category: 'Events',
    steps: [
      { stepType: 'page', name: 'Registration', templateId: 'webinar-bold', templateCategory: 'webinar', pageTitle: 'Free Webinar' },
      { stepType: 'thank_you', name: 'Confirmation', config: { message: "You're registered! Check your email for the webinar link and add it to your calendar." } },
      { stepType: 'page', name: 'Replay Page', templateId: 'webinar-warm', templateCategory: 'webinar', pageTitle: 'Webinar Replay' },
      { stepType: 'checkout', name: 'Special Offer', config: {} },
      { stepType: 'thank_you', name: 'Thank You', config: { message: 'Thank you for your purchase! You now have full access.' } },
    ],
  },
]

export async function GET() {
  return NextResponse.json({ ok: true, data: FUNNEL_TEMPLATES })
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { templateId } = body

    const template = FUNNEL_TEMPLATES.find(t => t.id === templateId)
    if (!template) return NextResponse.json({ ok: false, error: 'Template not found' }, { status: 404 })

    const funnelId = crypto.randomUUID()
    const slug = `${template.id}-${Date.now().toString(36)}`
    const now = new Date()

    // Create funnel
    await query(
      'INSERT INTO funnels (id, tenant_id, organization_id, name, slug, is_published, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [funnelId, auth.tenantId, auth.orgId, template.name, slug, false, now, now]
    )

    // Create steps and auto-create landing pages for page steps
    for (let i = 0; i < template.steps.length; i++) {
      const step = template.steps[i]
      const stepId = crypto.randomUUID()
      let pageId: string | null = null

      // Auto-create landing page for page-type steps
      if ((step.stepType === 'page' || step.stepType === 'lead_capture') && step.templateId) {
        pageId = crypto.randomUUID()
        const pageSlug = `${slug}-${step.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`

        // Create page with v2 wizard config so it can be edited later
        const pageConfig = {
          wizardVersion: 2,
          pageType: step.templateCategory === 'booking' ? 'book-a-call' : step.templateCategory === 'webinar' ? 'promote-event' : 'capture-leads',
          subType: 'general',
          framework: 'PAS',
          businessContext: { businessName: '', targetAudience: '', tone: 'professional', offerAnswers: {} },
          generatedSections: [],
          styleId: 'bold',
          formFields: [
            { label: 'Name', type: 'text', required: true },
            { label: 'Email', type: 'email', required: true },
          ],
        }

        // Create a simple placeholder published HTML so the page is immediately accessible
        const placeholderHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${step.pageTitle || step.name}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,system-ui,sans-serif;background:#f9fafb;color:#111;display:flex;justify-content:center;padding:48px 24px;min-height:100vh}
.wrap{max-width:560px;width:100%;text-align:center}.wrap h1{font-size:28px;font-weight:700;margin-bottom:12px}.wrap p{color:#555;margin-bottom:32px;line-height:1.6}
.form{background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.06)}.field{margin-bottom:16px;text-align:left}.field label{display:block;font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.field input{width:100%;padding:12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px}.btn{width:100%;padding:14px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}.btn:hover{background:#1d4ed8}
.success{display:none;padding:24px;text-align:center}.success.show{display:block}.success h3{margin-bottom:8px}</style></head>
<body><div class="wrap"><h1>${step.pageTitle || step.name}</h1><p>Complete the form below to get started.</p>
<div class="form"><form id="lp-form"><div class="field"><label>Name</label><input type="text" name="name" required placeholder="Your name"></div>
<div class="field"><label>Email</label><input type="email" name="email" required placeholder="you@example.com"></div>
<button type="submit" class="btn">Get Started</button></form>
<div id="lp-success" class="success"><h3>Thank you!</h3><p>We'll be in touch soon.</p></div></div></div>
<script>(function(){var f=document.getElementById('lp-form');if(!f)return;var s=false;f.addEventListener('submit',function(e){e.preventDefault();if(s)return;s=true;var d={};new FormData(f).forEach(function(v,k){d[k]=v});
var p=new URLSearchParams(window.location.search);['utm_source','utm_medium','utm_campaign'].forEach(function(k){var v=p.get(k);if(v)d['_'+k]=v});if(document.referrer)d['_referrer']=document.referrer;
var b=f.querySelector('[type=submit]');if(b){b.disabled=true;b.textContent='Sending...';}
fetch(window.location.origin+'/api/landing-pages/public/${pageSlug}/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:d})})
.then(function(r){return r.json()}).then(function(r){if(r.ok){f.style.display='none';var sv=document.getElementById('lp-success');if(sv){sv.classList.add('show');if(r.message)sv.querySelector('p').textContent=r.message;}}else{alert(r.error||'Something went wrong');s=false;if(b){b.disabled=false;b.textContent='Get Started';}}})
.catch(function(){s=false;if(b){b.disabled=false;b.textContent='Try Again';}});})})()</script></body></html>`

        await query(
          'INSERT INTO landing_pages (id, tenant_id, organization_id, title, slug, template_id, template_category, status, config, published_html, view_count, submission_count, created_at, updated_at, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
          [pageId, auth.tenantId, auth.orgId, step.pageTitle || step.name, pageSlug, step.templateId, step.templateCategory || null, 'published', JSON.stringify(pageConfig), placeholderHtml, 0, 0, now, now, now]
        )
        // Create default form for the submit endpoint
        await query(
          'INSERT INTO landing_page_forms (id, tenant_id, organization_id, landing_page_id, name, fields, success_message, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [crypto.randomUUID(), auth.tenantId, auth.orgId, pageId, 'default', JSON.stringify([
            { id: 'name', name: 'name', type: 'text', label: 'Name', required: true },
            { id: 'email', name: 'email', type: 'email', label: 'Email', required: true },
          ]), "Thank you! We'll be in touch.", now, now]
        )
      }

      await query(
        'INSERT INTO funnel_steps (id, funnel_id, step_order, step_type, page_id, name, config, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [stepId, funnelId, i + 1, step.stepType, pageId, step.name, JSON.stringify(step.config || {}), now]
      )
    }

    const funnel = await queryOne('SELECT * FROM funnels WHERE id = $1', [funnelId])
    const steps = await query('SELECT * FROM funnel_steps WHERE funnel_id = $1 ORDER BY step_order', [funnelId])

    return NextResponse.json({ ok: true, data: { ...funnel, steps } }, { status: 201 })
  } catch (error) {
    console.error('[funnel-templates.install]', error)
    const msg = error instanceof Error ? error.message : 'Failed'
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
