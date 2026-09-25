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

const STARTER_PAGE_TYPES: Record<string, { pageType: string; subType: string; subtitle: string; ctaText: string }> = {
  'lead-magnet': { pageType: 'capture-leads', subType: 'free-guide', subtitle: 'Describe your free resource here: what it is and what readers get from it.', ctaText: 'Send Me the Guide' },
  booking: { pageType: 'book-a-call', subType: 'discovery-call', subtitle: 'Describe your call here: who it is for and what they walk away with.', ctaText: 'Book My Call' },
  webinar: { pageType: 'promote-event', subType: 'webinar', subtitle: 'Describe your webinar here: the topic, the date and what attendees learn.', ctaText: 'Save My Seat' },
  'info-product': { pageType: 'sell-digital', subType: 'course', subtitle: 'Describe your product here: what is inside and who it is for.', ctaText: 'Get Instant Access' },
}

/** Wizard config for a funnel template's page: one editable hero plus a sign-up form. */
function funnelStarterPageConfig(step: FunnelTemplate['steps'][number]) {
  const starter = STARTER_PAGE_TYPES[step.templateCategory || ''] || STARTER_PAGE_TYPES['lead-magnet']
  return {
    wizardVersion: 2,
    pageType: starter.pageType,
    subType: starter.subType,
    framework: 'PAS',
    businessContext: { businessName: '', targetAudience: '', tone: 'professional', offerAnswers: {} },
    generatedSections: [
      { type: 'hero', headline: step.pageTitle || step.name, subtitle: starter.subtitle, ctaText: starter.ctaText },
    ],
    styleId: 'minimal',
    simpleLayout: true,
    formFields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Email', type: 'email', required: true },
    ],
  }
}

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

    const createdPages: Array<{ id: string; title: string; status: 'draft' }> = []

    // Create steps and auto-create landing pages for page steps
    for (let i = 0; i < template.steps.length; i++) {
      const step = template.steps[i]
      const stepId = crypto.randomUUID()
      let pageId: string | null = null

      // Auto-create landing page for page-type steps
      if ((step.stepType === 'page' || step.stepType === 'lead_capture') && step.templateId) {
        pageId = crypto.randomUUID()
        const pageSlug = `${slug}-${step.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`

        // A DRAFT page with editable starter copy. Nothing goes live until the
        // user edits and publishes it (a template used to publish a public
        // "Free Resource" page with placeholder copy straight away).
        const pageConfig = funnelStarterPageConfig(step)
        const pageTitle = step.pageTitle || step.name

        await query(
          'INSERT INTO landing_pages (id, tenant_id, organization_id, title, slug, template_id, template_category, status, config, published_html, view_count, submission_count, created_at, updated_at, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
          [pageId, auth.tenantId, auth.orgId, pageTitle, pageSlug, step.templateId, step.templateCategory || null, 'draft', JSON.stringify(pageConfig), null, 0, 0, now, now, null]
        )
        createdPages.push({ id: pageId, title: pageTitle, status: 'draft' })
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

    return NextResponse.json({ ok: true, data: { ...funnel, steps, createdPages } }, { status: 201 })
  } catch (error) {
    console.error('[funnel-templates.install]', error)
    const msg = error instanceof Error ? error.message : 'Failed'
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
