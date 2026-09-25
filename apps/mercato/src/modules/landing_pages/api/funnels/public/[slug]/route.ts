import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'
import { cookies } from 'next/headers'

export const metadata = {
  // Public visitor entry point for a published funnel (reached via /f/{slug}).
  GET: { requireAuth: false },
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function getOrCreateSession(knex: any, funnelId: string, orgId: string, visitorId: string, firstStepId: string) {
  // Find existing active session for this visitor + funnel
  let session = await knex('funnel_sessions')
    .where('funnel_id', funnelId)
    .where('visitor_id', visitorId)
    .where('status', 'active')
    .first()

  if (!session) {
    const id = crypto.randomUUID()
    await knex('funnel_sessions').insert({
      id, funnel_id: funnelId, organization_id: orgId,
      visitor_id: visitorId, current_step_id: firstStepId,
      status: 'active', started_at: new Date(), updated_at: new Date(),
    })
    session = await knex('funnel_sessions').where('id', id).first()
  }

  return session
}

function renderThankYou(message: string, session: any, orders: any[]) {
  const safeMsg = escapeHtml(message)
  const orderRows = orders.filter((o: any) => o.status === 'succeeded').map((o: any) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb">${escapeHtml(o.product_name || o.order_type)}</td><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right">$${Number(o.amount).toFixed(2)}</td></tr>`
  ).join('')

  const totalAmount = orders.filter((o: any) => o.status === 'succeeded').reduce((s: number, o: any) => s + Number(o.amount), 0)

  const orderSummary = orders.length > 0 ? `
    <div style="margin-top:32px;max-width:400px;margin-left:auto;margin-right:auto;text-align:left">
      <h2 style="font-size:14px;color:#6b7280;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px">Order Summary</h2>
      <table style="width:100%;border-collapse:collapse">${orderRows}
        <tr><td style="padding:12px 0;font-weight:700">Total</td><td style="padding:12px 0;font-weight:700;text-align:right">$${totalAmount.toFixed(2)}</td></tr>
      </table>
    </div>` : ''

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank You</title>
<style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:-apple-system,system-ui,sans-serif;margin:0;background:#f9fafb;color:#111827}</style>
</head><body><div style="text-align:center;padding:48px;max-width:600px">
<h1 style="font-size:1.5rem;margin-bottom:16px">${safeMsg}</h1>
${orderSummary}
</div></body></html>`
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    await bootstrap()
    const { slug } = await params
    const url = new URL(req.url)
    const stepParam = url.searchParams.get('step')
    const sidParam = url.searchParams.get('sid')

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const funnel = await knex('funnels').where('slug', slug).where('is_published', true).first()
    if (!funnel) return new Response('Funnel not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })

    const steps = await knex('funnel_steps').where('funnel_id', funnel.id).orderBy('step_order')
    if (steps.length === 0) return new Response('Funnel has no steps', { status: 404, headers: { 'Content-Type': 'text/plain' } })

    // Get or create visitor ID from cookie
    const cookieStore = await cookies()
    let visitorId = cookieStore.get('funnel_vid')?.value
    if (!visitorId) visitorId = crypto.randomUUID()

    // Determine which step to show
    let currentStep = steps[0]
    if (stepParam) {
      const found = steps.find((s: any) => s.id === stepParam || String(s.step_order) === stepParam)
      if (found) currentStep = found
    }

    // Get or create session
    const session = await getOrCreateSession(knex, funnel.id, funnel.organization_id, visitorId, currentStep.id)

    // Update session's current step
    await knex('funnel_sessions').where('id', session.id).update({ current_step_id: currentStep.id, updated_at: new Date() })

    // Record visit
    await knex('funnel_visits').insert({
      id: crypto.randomUUID(),
      funnel_id: funnel.id,
      step_id: currentStep.id,
      session_id: session.id,
      visitor_id: visitorId,
      action: 'view',
      created_at: new Date(),
    })

    const baseUrl = process.env.APP_URL || url.origin
    const config = typeof currentStep.config === 'string' ? JSON.parse(currentStep.config) : (currentStep.config || {})

    // Build response based on step type
    let response: Response

    if ((currentStep.step_type === 'page' || currentStep.step_type === 'lead_capture') && currentStep.page_id) {
      const page = await knex('landing_pages').where('id', currentStep.page_id).where('status', 'published').first()
      if (page) {
        // Redirect to landing page with funnel context in query params
        response = NextResponse.redirect(`${baseUrl}/api/landing_pages/public/${page.slug}?funnel_sid=${session.id}&funnel_step=${currentStep.id}&funnel_slug=${slug}`)
      } else {
        response = new Response('Landing page not found', { status: 404 })
      }
    } else if (currentStep.step_type === 'checkout') {
      // Redirect to checkout initiation page
      response = NextResponse.redirect(`${baseUrl}/api/landing_pages/funnels/public/${slug}/checkout?sid=${session.id}&step=${currentStep.id}`)
    } else if (currentStep.step_type === 'upsell' || currentStep.step_type === 'downsell') {
      // Render upsell/downsell page inline
      const product = currentStep.product_id
        ? await knex('products').where('id', currentStep.product_id).where('organization_id', funnel.organization_id).first()
        : null
      const productName = product?.name || config.headline || 'Special Offer'
      const productPrice = product?.price || config.price || 0
      const description = config.description || product?.description || ''
      const acceptText = config.accept_button_text || 'Yes! Add this to my order'
      const declineText = config.decline_button_text || 'No thanks, I\'ll pass'
      const isDownsell = currentStep.step_type === 'downsell'

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(productName)}</title>
<style>*{box-sizing:border-box}body{margin:0;padding:0;font-family:-apple-system,system-ui,sans-serif;background:#f9fafb;color:#111827;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{max-width:520px;width:100%;margin:24px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);overflow:hidden}
.header{padding:32px 32px 24px;text-align:center;background:${isDownsell ? '#fef3c7' : '#eff6ff'};border-bottom:1px solid ${isDownsell ? '#fde68a' : '#bfdbfe'}}
.header h1{margin:0 0 8px;font-size:24px;font-weight:700}
.header .tag{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${isDownsell ? '#92400e' : '#1d4ed8'};margin-bottom:12px;display:inline-block}
.body{padding:32px}
.price{font-size:36px;font-weight:800;text-align:center;margin:16px 0;color:#111827}
.price .currency{font-size:18px;vertical-align:super}
.desc{font-size:15px;line-height:1.6;color:#4b5563;margin-bottom:24px}
.btn-accept{display:block;width:100%;padding:16px;border:none;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;background:#16a34a;color:#fff;margin-bottom:12px;transition:background .15s}
.btn-accept:hover{background:#15803d}
.btn-decline{display:block;width:100%;padding:12px;border:none;background:none;font-size:13px;color:#9ca3af;cursor:pointer;text-decoration:underline}
.btn-decline:hover{color:#6b7280}
.processing{display:none;text-align:center;padding:20px;color:#6b7280}
</style></head><body>
<div class="card">
  <div class="header">
    <span class="tag">${isDownsell ? 'Wait — special offer' : 'One-time offer'}</span>
    <h1>${escapeHtml(productName)}</h1>
  </div>
  <div class="body">
    <div class="price"><span class="currency">$</span>${Number(productPrice).toFixed(2)}</div>
    <p class="desc">${escapeHtml(description)}</p>
    <div id="buttons">
      <button class="btn-accept" onclick="handleAccept()">${escapeHtml(acceptText)}</button>
      <button class="btn-decline" onclick="handleDecline()">${escapeHtml(declineText)}</button>
    </div>
    <div class="processing" id="processing">Processing your order...</div>
  </div>
</div>
<script>
function handleAccept(){
  document.getElementById('buttons').style.display='none';
  document.getElementById('processing').style.display='block';
  fetch('${baseUrl}/api/landing_pages/funnels/public/${slug}/upsell',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({sid:'${session.id}',stepId:'${currentStep.id}',action:'accept'})
  }).then(r=>r.json()).then(d=>{
    if(d.redirectUrl) window.location.href=d.redirectUrl;
    else { document.getElementById('processing').textContent=d.error||'Payment failed'; document.getElementById('buttons').style.display='block'; }
  }).catch(()=>{ document.getElementById('processing').textContent='Something went wrong'; document.getElementById('buttons').style.display='block'; });
}
function handleDecline(){
  fetch('${baseUrl}/api/landing_pages/funnels/public/${slug}/upsell',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({sid:'${session.id}',stepId:'${currentStep.id}',action:'decline'})
  }).then(r=>r.json()).then(d=>{
    if(d.redirectUrl) window.location.href=d.redirectUrl;
  });
}
</script>
</body></html>`
      response = new Response(html, { headers: { 'Content-Type': 'text/html' } })
    } else if (currentStep.step_type === 'thank_you') {
      const message = config.message || 'Thank you for your purchase!'
      // Load orders for this session
      const orders = await knex('funnel_orders as fo')
        .leftJoin('products as p', 'p.id', 'fo.product_id')
        .where('fo.session_id', session.id)
        .select('fo.*', 'p.name as product_name')
        .orderBy('fo.created_at')

      // Mark session as completed
      await knex('funnel_sessions').where('id', session.id).update({ status: 'completed', completed_at: new Date(), updated_at: new Date() })

      response = new Response(renderThankYou(message, session, orders), { headers: { 'Content-Type': 'text/html' } })
    } else {
      response = new Response('Step not configured', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    }

    // Set visitor cookie on response
    if (response instanceof NextResponse) {
      response.cookies.set('funnel_vid', visitorId, { httpOnly: true, maxAge: 365 * 24 * 60 * 60, sameSite: 'lax', path: '/' })
    } else {
      const newResponse = new Response(response.body, { status: response.status, headers: new Headers(response.headers) })
      newResponse.headers.append('Set-Cookie', `funnel_vid=${visitorId}; HttpOnly; Max-Age=${365 * 24 * 60 * 60}; SameSite=Lax; Path=/`)
      return newResponse
    }

    return response
  } catch (error) {
    console.error('[funnels.public]', error)
    return new Response('Internal Server Error', { status: 500, headers: { 'Content-Type': 'text/plain' } })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Funnels',
  summary: 'Public funnel entry point',
  methods: {
    GET: { summary: 'View public funnel step (multi-step navigation)', tags: ['Funnels'] },
  },
}
