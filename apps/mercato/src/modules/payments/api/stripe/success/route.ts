export const metadata = { GET: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { queryOne } from '@/app/api/funnels/db'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get('session_id')

  let amount = ''
  let currency = 'USD'
  let businessName = ''
  let invoiceNumber = ''
  let customerEmail = ''
  let logoUrl = ''

  if (sessionId) {
    try {
      const paymentRecord = await queryOne(
        `SELECT pr.amount, pr.currency, pr.organization_id, pr.metadata FROM payment_records pr WHERE pr.stripe_checkout_session_id = $1 LIMIT 1`,
        [sessionId]
      )
      if (paymentRecord) {
        amount = Number(paymentRecord.amount).toFixed(2)
        currency = (paymentRecord.currency || 'USD').toUpperCase()

        const meta = typeof paymentRecord.metadata === 'string' ? JSON.parse(paymentRecord.metadata) : paymentRecord.metadata || {}
        customerEmail = meta.customer_email || ''

        // Get invoice number if linked
        if (meta.invoiceId) {
          const inv = await queryOne('SELECT invoice_number FROM invoices WHERE id = $1', [meta.invoiceId])
          if (inv) invoiceNumber = inv.invoice_number
        }

        // Get business profile
        const bp = await queryOne(
          'SELECT business_name FROM business_profiles WHERE organization_id = $1 LIMIT 1',
          [paymentRecord.organization_id]
        )
        if (bp?.business_name) businessName = bp.business_name
      }
    } catch {}
  }

  const seller = businessName || 'the seller'
  const esc = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const detailRows = [
    amount ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Amount</td><td style="padding:8px 0;text-align:right;font-weight:600;font-size:15px">$${amount} ${currency}</td></tr>` : '',
    invoiceNumber ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Invoice</td><td style="padding:8px 0;text-align:right;font-size:13px">${esc(invoiceNumber)}</td></tr>` : '',
    customerEmail ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Receipt sent to</td><td style="padding:8px 0;text-align:right;font-size:13px">${esc(customerEmail)}</td></tr>` : '',
  ].filter(Boolean).join('')

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Successful — ${esc(seller)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:linear-gradient(135deg,#ffffff 0%,#f0f0f5 100%);padding:20px}
  .card{text-align:center;padding:48px 40px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:460px;width:100%}
  .check{width:72px;height:72px;background:#dcfce7;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}
  .check svg{width:36px;height:36px;color:#16a34a}
  h1{font-size:24px;font-weight:700;color:#111;margin:0 0 8px}
  .subtitle{color:#666;font-size:15px;line-height:1.6;margin:0 0 24px}
  .details{text-align:left;margin:0 auto 24px;width:100%}
  .details table{width:100%;border-collapse:collapse}
  .details table tr:not(:last-child) td{border-bottom:1px solid #f3f4f6}
  .footer{margin-top:24px;font-size:12px;color:#aaa}
  .brand{font-weight:600;color:#111;font-size:14px;margin-bottom:24px}
</style>
</head><body>
<div class="card">
  ${businessName ? `<p class="brand">${esc(businessName)}</p>` : ''}
  <div class="check">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
  </div>
  <h1>Payment Successful!</h1>
  <p class="subtitle">Thank you for your payment.${customerEmail ? ' A confirmation has been sent to your email.' : ''}</p>
  ${detailRows ? `<div class="details"><table>${detailRows}</table></div>` : ''}
  <p class="footer">If you have any questions, please contact ${esc(seller)} directly.</p>
</div>
</body></html>`

  return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
}
