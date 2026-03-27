import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

export const metadata = { GET: { requireAuth: false } }

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const url = new URL(req.url)
    const stepParam = parseInt(url.searchParams.get('step') || '1', 10)

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const funnel = await knex('funnels').where('slug', slug).where('is_published', true).first()
    if (!funnel) {
      return new NextResponse(
        '<html><body style="font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#64748b"><h1>Funnel not found</h1></body></html>',
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      )
    }

    const steps = await knex('funnel_steps').where('funnel_id', funnel.id).orderBy('step_order', 'asc')
    const currentStep = steps.find((s: { step_order: number }) => s.step_order === stepParam)
    if (!currentStep) {
      return new NextResponse(
        '<html><body style="font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#64748b"><h1>Step not found</h1></body></html>',
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      )
    }

    const visitorId = crypto.randomUUID().substring(0, 16)
    await knex('funnel_visits').insert({
      id: crypto.randomUUID(),
      funnel_id: funnel.id,
      step_id: currentStep.id,
      visitor_id: visitorId,
      created_at: new Date(),
    })

    const stepConfig = typeof currentStep.config === 'string' ? JSON.parse(currentStep.config) : (currentStep.config || {})
    const nextStep = steps.find((s: { step_order: number }) => s.step_order === stepParam + 1)
    const nextStepUrl = nextStep ? `/api/funnels/public/${slug}?step=${nextStep.step_order}` : null

    if (currentStep.step_type === 'checkout') {
      const checkoutUrl = stepConfig.checkoutUrl || stepConfig.stripeUrl
      if (checkoutUrl) {
        return NextResponse.redirect(checkoutUrl)
      }
      return new NextResponse(
        '<html><body style="font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#64748b"><h1>Checkout not configured</h1></body></html>',
        { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      )
    }

    if (currentStep.step_type === 'thank_you') {
      const message = escapeHtml(stepConfig.message || 'Thank you!')
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Thank You</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f8fafc; color: #1e293b; min-height: 100vh;
      display: flex; justify-content: center; align-items: center; padding: 2rem;
    }
    .card {
      background: #fff; border-radius: 16px; border: 1px solid #e2e8f0;
      box-shadow: 0 4px 24px rgba(0,0,0,0.06); padding: 3rem; text-align: center;
      max-width: 520px; width: 100%;
    }
    .check-icon {
      width: 72px; height: 72px; background: #ecfdf5; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem;
      color: #10b981; font-size: 2.5rem;
    }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.75rem; color: #0f172a; }
    p { color: #64748b; font-size: 1rem; line-height: 1.6; }
    .powered { text-align: center; color: #94a3b8; font-size: 0.75rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <div>
    <div class="card">
      <div class="check-icon">&#10003;</div>
      <h1>Thank You!</h1>
      <p>${message}</p>
    </div>
    <div class="powered">Powered by Open Mercato</div>
  </div>
</body>
</html>`
      return new NextResponse(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    // step_type === 'page': serve landing page HTML with funnel navigation injected
    if (!currentStep.page_id) {
      return new NextResponse(
        '<html><body style="font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#64748b"><h1>No page configured for this step</h1></body></html>',
        { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      )
    }

    const landingPage = await knex('landing_pages').where('id', currentStep.page_id).first()
    if (!landingPage || !landingPage.published_html) {
      return new NextResponse(
        '<html><body style="font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#64748b"><h1>Page not found or not published</h1></body></html>',
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      )
    }

    let pageHtml = landingPage.published_html as string

    // Inject funnel navigation script before </body>
    const funnelScript = `<script>
(function() {
  var nextUrl = ${nextStepUrl ? JSON.stringify(nextStepUrl) : 'null'};

  // Override all form submissions to advance to next funnel step
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    e.preventDefault();

    var formData = new FormData(form);
    var data = {};
    formData.forEach(function(val, key) {
      if (data[key] !== undefined) {
        if (!Array.isArray(data[key])) data[key] = [data[key]];
        data[key].push(val);
      } else {
        data[key] = val;
      }
    });

    // Try to submit to the original action, then advance
    var action = form.getAttribute('action') || window.location.href;
    var method = (form.getAttribute('method') || 'POST').toUpperCase();

    fetch(action, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(function() {
      if (nextUrl) {
        window.location.href = nextUrl;
      }
    }).catch(function() {
      // Still advance even if submit fails
      if (nextUrl) {
        window.location.href = nextUrl;
      }
    });
  }, true);

  // Track visit
  try {
    navigator.sendBeacon('/api/funnels/public/${slug}?_track=1&step=${stepParam}');
  } catch(e) {}
})();
</script>`

    if (pageHtml.includes('</body>')) {
      pageHtml = pageHtml.replace('</body>', funnelScript + '\n</body>')
    } else {
      pageHtml += funnelScript
    }

    return new NextResponse(pageHtml, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch {
    return new NextResponse('<html><body>Error loading funnel</body></html>', {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
}
