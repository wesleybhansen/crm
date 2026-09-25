import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

export const metadata = {
  // Public funnel checkout, reached by signed-out visitors.
  GET: { requireAuth: false },
  POST: { requireAuth: false },
}

/** A product of the funnel's own organization and tenant, or null. */
async function funnelProduct(knex: any, funnel: { organization_id: string; tenant_id?: string | null }, productId: unknown) {
  if (typeof productId !== 'string' || !productId) return null
  const query = knex('products').where('id', productId).where('organization_id', funnel.organization_id)
  if (funnel.tenant_id) query.where('tenant_id', funnel.tenant_id)
  return (await query.first()) ?? null
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// GET: Render pre-checkout page (collects email, shows product + order bumps)
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    await bootstrap()
    const { slug } = await params
    const url = new URL(req.url)
    const sid = url.searchParams.get('sid')
    const stepId = url.searchParams.get('step')

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const funnel = await knex('funnels').where('slug', slug).where('is_published', true).first()
    if (!funnel) return new Response('Funnel not found', { status: 404 })

    // Session, step and products are bound to THIS funnel and its owner: a
    // step id or sid from another funnel (they leak through redirect query
    // strings) must never render or price that funnel's checkout (2026-09-25
    // review, M7).
    const session = sid ? await knex('funnel_sessions').where('id', sid).where('funnel_id', funnel.id).first() : null
    const step = stepId
      ? await knex('funnel_steps').where('id', stepId).where('funnel_id', funnel.id).first()
      : await knex('funnel_steps').where('funnel_id', funnel.id).where('step_type', 'checkout').orderBy('step_order').first()
    if (!step) return new Response('Checkout step not found', { status: 404 })

    const config = typeof step.config === 'string' ? JSON.parse(step.config) : (step.config || {})
    const product = step.product_id ? await funnelProduct(knex, funnel, step.product_id) : null
    const productName = product?.name || config.productName || 'Product'
    const productPrice = product?.price || config.price || 0
    const productDesc = product?.description || config.description || ''

    // Load order bumps from config
    const bumps = config.order_bumps || []
    let bumpHtml = ''
    for (const bump of bumps) {
      const bumpProduct = bump.product_id ? await funnelProduct(knex, funnel, bump.product_id) : null
      const bName = bumpProduct?.name || bump.headline || 'Add-on'
      const bPrice = bumpProduct?.price || bump.price || 0
      const bDesc = bump.description || bumpProduct?.description || ''
      bumpHtml += `
        <label style="display:flex;align-items:flex-start;gap:12px;padding:16px;border:2px dashed #d1d5db;border-radius:8px;cursor:pointer;margin-bottom:8px;transition:border-color .15s"
          onmouseover="this.style.borderColor='#3b82f6'" onmouseout="this.style.borderColor=this.querySelector('input').checked?'#3b82f6':'#d1d5db'">
          <input type="checkbox" name="bump" value="${escapeHtml(bump.product_id || '')}" data-price="${bPrice}"
            style="margin-top:3px;width:18px;height:18px" ${bump.checked_by_default ? 'checked' : ''}
            onchange="this.parentElement.style.borderColor=this.checked?'#3b82f6':'#d1d5db';updateTotal()">
          <div style="flex:1">
            <div style="font-weight:600;font-size:14px;color:#111827">${escapeHtml(bName)} — $${Number(bPrice).toFixed(2)}</div>
            <div style="font-size:13px;color:#6b7280;margin-top:2px">${escapeHtml(bDesc)}</div>
          </div>
        </label>`
    }

    const baseUrl = process.env.APP_URL || url.origin
    const prefillEmail = session?.email || ''

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout - ${escapeHtml(productName)}</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#f9fafb;color:#111827;min-height:100vh;display:flex;align-items:center;justify-content:center}
.checkout{max-width:480px;width:100%;margin:24px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);overflow:hidden}
.header{padding:24px 32px;background:#111827;color:#fff;text-align:center}
.header h1{margin:0;font-size:20px;font-weight:700}
.header .price{font-size:28px;font-weight:800;margin-top:8px}
.body{padding:32px}
.field{margin-bottom:16px}
.field label{display:block;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
.field input{width:100%;padding:12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;outline:none;transition:border-color .15s}
.field input:focus{border-color:#3b82f6}
.bumps{margin:20px 0}
.bumps h3{font-size:13px;font-weight:600;color:#374151;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.5px}
.total{text-align:center;font-size:18px;font-weight:700;margin:20px 0;padding:16px;background:#f3f4f6;border-radius:8px}
.btn{display:block;width:100%;padding:16px;border:none;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;background:#16a34a;color:#fff;transition:background .15s}
.btn:hover{background:#15803d}
.btn:disabled{background:#9ca3af;cursor:not-allowed}
.secure{text-align:center;font-size:11px;color:#9ca3af;margin-top:12px}
</style></head><body>
<div class="checkout">
  <div class="header">
    <h1>${escapeHtml(productName)}</h1>
    ${productDesc ? `<p style="margin:8px 0 0;font-size:14px;opacity:.8">${escapeHtml(productDesc)}</p>` : ''}
    <div class="price">$${Number(productPrice).toFixed(2)}</div>
  </div>
  <div class="body">
    <form id="checkoutForm" onsubmit="return handleCheckout(event)">
      <div class="field">
        <label>Full Name</label>
        <input type="text" name="name" required placeholder="Your name">
      </div>
      <div class="field">
        <label>Email Address</label>
        <input type="email" name="email" required placeholder="you@example.com" value="${escapeHtml(prefillEmail)}">
      </div>
      ${bumpHtml ? `<div class="bumps"><h3>Add to your order</h3>${bumpHtml}</div>` : ''}
      <div class="total" id="totalDisplay">Total: $${Number(productPrice).toFixed(2)}</div>
      <button type="submit" class="btn" id="submitBtn">Proceed to Payment</button>
      <p class="secure">Secure checkout powered by Stripe</p>
    </form>
  </div>
</div>
<script>
var basePrice = ${Number(productPrice)};
function updateTotal(){
  var total = basePrice;
  document.querySelectorAll('input[name=bump]:checked').forEach(function(cb){total += Number(cb.dataset.price)});
  document.getElementById('totalDisplay').textContent = 'Total: $' + total.toFixed(2);
}
function handleCheckout(e){
  e.preventDefault();
  var btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'Redirecting to payment...';
  var form = document.getElementById('checkoutForm');
  var bumps = [];
  document.querySelectorAll('input[name=bump]:checked').forEach(function(cb){bumps.push(cb.value)});
  fetch('${baseUrl}/api/landing_pages/funnels/public/${slug}/checkout', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      sid: '${session?.id || ''}',
      stepId: '${step.id}',
      name: form.elements.name.value,
      email: form.elements.email.value,
      bumpProductIds: bumps
    })
  }).then(function(r){return r.json()}).then(function(d){
    if(d.checkoutUrl) window.location.href = d.checkoutUrl;
    else { btn.disabled=false; btn.textContent='Proceed to Payment'; alert(d.error||'Failed to create checkout'); }
  }).catch(function(){btn.disabled=false; btn.textContent='Proceed to Payment'; alert('Something went wrong');});
  return false;
}
updateTotal();
</script>
</body></html>`

    return new Response(html, { headers: { 'Content-Type': 'text/html' } })
  } catch (error) {
    console.error('[funnel.checkout.GET]', error)
    return new Response('Error loading checkout', { status: 500 })
  }
}

// POST: Create Stripe Checkout session
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    await bootstrap()
    const { slug } = await params
    const body = await req.json()
    const { sid, stepId, name, email, bumpProductIds } = body

    if (!email?.trim()) return NextResponse.json({ ok: false, error: 'Email is required' }, { status: 400 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const funnel = await knex('funnels').where('slug', slug).where('is_published', true).first()
    if (!funnel) return NextResponse.json({ ok: false, error: 'Funnel not found' }, { status: 404 })

    const step = await knex('funnel_steps').where('id', stepId).where('funnel_id', funnel.id).first()
    if (!step) return NextResponse.json({ ok: false, error: 'Step not found' }, { status: 404 })

    const config = typeof step.config === 'string' ? JSON.parse(step.config) : (step.config || {})

    // Get org's Stripe connection
    const stripeConnection = await knex('stripe_connections')
      .where('organization_id', funnel.organization_id)
      .where('is_active', true)
      .first()

    const stripeKey = process.env.STRIPE_SECRET_KEY
    if (!stripeKey || !stripeConnection?.stripe_account_id) {
      return NextResponse.json({ ok: false, error: 'Payment processing is not configured' }, { status: 400 })
    }

    // Get product for this step (the funnel owner's own product only)
    const product = step.product_id ? await funnelProduct(knex, funnel, step.product_id) : null
    if (!product) return NextResponse.json({ ok: false, error: 'No product configured for this checkout step' }, { status: 400 })

    // Build line items
    const lineItems: any[] = [{
      price_data: {
        currency: (product.currency || 'usd').toLowerCase(),
        product_data: { name: product.name, description: product.description || undefined },
        unit_amount: Math.round(Number(product.price) * 100),
      },
      quantity: 1,
    }]

    // Add order bumps: only the bumps this step offers, each once, and only
    // the funnel owner's own products. Any other product id from the request
    // body is ignored (it used to be charged, at that product's price).
    const offeredBumps = new Set(
      (Array.isArray(config.order_bumps) ? config.order_bumps : [])
        .map((bump: any) => (typeof bump?.product_id === 'string' ? bump.product_id : ''))
        .filter(Boolean),
    )
    const bumpIds: string[] = Array.from(new Set(
      (Array.isArray(bumpProductIds) ? bumpProductIds : [])
        .filter((id: unknown): id is string => typeof id === 'string' && offeredBumps.has(id)),
    ))
    for (const bumpProdId of bumpIds) {
      const bumpProduct = await funnelProduct(knex, funnel, bumpProdId)
      if (bumpProduct) {
        lineItems.push({
          price_data: {
            currency: (bumpProduct.currency || 'usd').toLowerCase(),
            product_data: { name: bumpProduct.name },
            unit_amount: Math.round(Number(bumpProduct.price) * 100),
          },
          quantity: 1,
        })
      }
    }

    // Update or create session (a sid from another funnel is not reused)
    let session = sid ? await knex('funnel_sessions').where('id', sid).where('funnel_id', funnel.id).first() : null
    if (session) {
      await knex('funnel_sessions').where('id', session.id).update({ email: email.trim(), updated_at: new Date() })
    } else {
      const sessionId = crypto.randomUUID()
      await knex('funnel_sessions').insert({
        id: sessionId, funnel_id: funnel.id, organization_id: funnel.organization_id,
        visitor_id: crypto.randomUUID(), email: email.trim(),
        current_step_id: step.id, status: 'active',
        started_at: new Date(), updated_at: new Date(),
      })
      session = await knex('funnel_sessions').where('id', sessionId).first()
    }

    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' as any })

    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    // Find the next step after checkout for the success URL
    const nextStep = await knex('funnel_steps')
      .where('funnel_id', funnel.id)
      .where('step_order', '>', step.step_order)
      .orderBy('step_order')
      .first()

    const successUrl = nextStep
      ? `${baseUrl}/api/landing_pages/funnels/public/${slug}?step=${nextStep.id}&sid=${session.id}`
      : `${baseUrl}/api/landing_pages/funnels/public/${slug}?step=thank_you&sid=${session.id}`

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      customer_email: email.trim(),
      payment_intent_data: {
        setup_future_usage: 'off_session',
      },
      metadata: {
        type: 'funnel',
        funnelId: funnel.id,
        funnelSlug: slug,
        stepId: step.id,
        sessionId: session.id,
        orgId: funnel.organization_id,
        tenantId: funnel.tenant_id,
        customerName: name?.trim() || '',
        customerEmail: email.trim(),
        bumpProductIds: bumpIds.join(','),
      },
      success_url: successUrl,
      cancel_url: `${baseUrl}/api/landing_pages/funnels/public/${slug}/checkout?sid=${session.id}&step=${step.id}`,
    }, {
      stripeAccount: stripeConnection.stripe_account_id,
    })

    // Create pending funnel order
    await knex('funnel_orders').insert({
      id: crypto.randomUUID(),
      session_id: session.id,
      funnel_id: funnel.id,
      step_id: step.id,
      product_id: product.id,
      amount: Number(product.price),
      currency: (product.currency || 'USD').toUpperCase(),
      order_type: 'checkout',
      stripe_checkout_session_id: checkoutSession.id,
      status: 'pending',
      created_at: new Date(),
    })

    // Create bump orders too
    for (const bumpProdId of bumpIds) {
      const bp = await funnelProduct(knex, funnel, bumpProdId)
      if (bp) {
        await knex('funnel_orders').insert({
          id: crypto.randomUUID(),
          session_id: session.id, funnel_id: funnel.id, step_id: step.id,
          product_id: bp.id, amount: Number(bp.price),
          currency: (bp.currency || 'USD').toUpperCase(),
          order_type: 'order_bump',
          stripe_checkout_session_id: checkoutSession.id,
          status: 'pending', created_at: new Date(),
        })
      }
    }

    return NextResponse.json({ ok: true, checkoutUrl: checkoutSession.url })
  } catch (error) {
    console.error('[funnel.checkout.POST]', error)
    const message = error instanceof Error ? error.message : 'Failed to create checkout'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
