
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: false },
}

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const affiliate = await knex('affiliates')
      .where('affiliate_code', code)
      .first()

    if (!affiliate) {
      return new NextResponse('Affiliate not found', { status: 404 })
    }

    const referrals = await knex('affiliate_referrals')
      .where('affiliate_id', affiliate.id)
      .orderBy('referred_at', 'desc')
      .limit(50)

    const payouts = await knex('affiliate_payouts')
      .where('affiliate_id', affiliate.id)
      .orderBy('created_at', 'desc')
      .limit(20)

    const origin = new URL(req.url).origin
    const referralLink = `${origin}/api/affiliates/ref/${affiliate.affiliate_code}`

    const totalPaid = payouts
      .filter((p: Record<string, unknown>) => p.status === 'paid')
      .reduce((sum: number, p: Record<string, unknown>) => sum + Number(p.amount), 0)
    const pendingPayout = payouts
      .filter((p: Record<string, unknown>) => p.status === 'pending')
      .reduce((sum: number, p: Record<string, unknown>) => sum + Number(p.amount), 0)

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Affiliate Dashboard - ${escapeHtml(affiliate.name)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem 1rem; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.5rem; }
    .subtitle { color: #64748b; margin-bottom: 2rem; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat-card { background: #fff; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .stat-label { font-size: 0.8rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
    .stat-value { font-size: 1.5rem; font-weight: 700; color: #0f172a; }
    .stat-value.green { color: #16a34a; }
    .referral-box { background: #fff; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 2rem; }
    .referral-box label { font-size: 0.85rem; color: #64748b; display: block; margin-bottom: 0.5rem; }
    .link-row { display: flex; gap: 0.5rem; }
    .link-input { flex: 1; padding: 0.625rem 0.75rem; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 0.9rem; background: #f8fafc; color: #334155; }
    .copy-btn { padding: 0.625rem 1rem; background: #3b82f6; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
    .copy-btn:hover { background: #2563eb; }
    .section { background: #fff; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 2rem; }
    .section h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th { text-align: left; padding: 0.625rem 0.5rem; border-bottom: 2px solid #e2e8f0; color: #64748b; font-weight: 500; }
    td { padding: 0.625rem 0.5rem; border-bottom: 1px solid #f1f5f9; }
    .badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
    .badge-green { background: #dcfce7; color: #166534; }
    .badge-gray { background: #f1f5f9; color: #475569; }
    .badge-yellow { background: #fef9c3; color: #854d0e; }
    .empty { text-align: center; padding: 2rem; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Affiliate Dashboard</h1>
    <p class="subtitle">Welcome, ${escapeHtml(affiliate.name)}</p>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Referrals</div>
        <div class="stat-value">${affiliate.total_referrals}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Conversions</div>
        <div class="stat-value">${affiliate.total_conversions}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Earned</div>
        <div class="stat-value green">$${Number(affiliate.total_earned).toFixed(2)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Commission Rate</div>
        <div class="stat-value">${affiliate.commission_type === 'percentage' ? Number(affiliate.commission_rate).toFixed(0) + '%' : '$' + Number(affiliate.commission_rate).toFixed(2)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Paid</div>
        <div class="stat-value green">$${totalPaid.toFixed(2)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pending Payout</div>
        <div class="stat-value">${pendingPayout > 0 ? '$' + pendingPayout.toFixed(2) : '$0.00'}</div>
      </div>
    </div>

    <div class="referral-box">
      <label>Your Referral Link</label>
      <div class="link-row">
        <input class="link-input" id="refLink" value="${escapeHtml(referralLink)}" readonly />
        <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('refLink').value);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)">Copy</button>
      </div>
    </div>

    <div class="section">
      <h2>Recent Referrals</h2>
      ${referrals.length === 0 ? '<p class="empty">No referrals yet. Share your referral link to get started!</p>' : `
      <table>
        <thead><tr><th>Email</th><th>Date</th><th>Status</th><th>Value</th><th>Commission</th></tr></thead>
        <tbody>
          ${referrals.map((r: Record<string, unknown>) => `
          <tr>
            <td>${escapeHtml(String(r.referred_email || 'Anonymous'))}</td>
            <td>${new Date(String(r.referred_at)).toLocaleDateString()}</td>
            <td><span class="badge ${r.converted ? 'badge-green' : 'badge-gray'}">${r.converted ? 'Converted' : 'Pending'}</span></td>
            <td>${r.conversion_value ? '$' + Number(r.conversion_value).toFixed(2) : '-'}</td>
            <td>${r.commission_amount ? '$' + Number(r.commission_amount).toFixed(2) : '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>

    <div class="section">
      <h2>Payout History</h2>
      ${payouts.length === 0 ? '<p class="empty">No payouts yet.</p>' : `
      <table>
        <thead><tr><th>Amount</th><th>Period</th><th>Status</th><th>Paid At</th></tr></thead>
        <tbody>
          ${payouts.map((p: Record<string, unknown>) => `
          <tr>
            <td>$${Number(p.amount).toFixed(2)}</td>
            <td>${new Date(String(p.period_start)).toLocaleDateString()} - ${new Date(String(p.period_end)).toLocaleDateString()}</td>
            <td><span class="badge ${p.status === 'paid' ? 'badge-green' : 'badge-yellow'}">${String(p.status).charAt(0).toUpperCase() + String(p.status).slice(1)}</span></td>
            <td>${p.paid_at ? new Date(String(p.paid_at)).toLocaleDateString() : '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  </div>
</body>
</html>`

    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch (error) {
    console.error('[affiliates.dashboard] failed', error)
    return new NextResponse('Something went wrong', { status: 500 })
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Affiliates',
  summary: 'Public affiliate dashboard',
  methods: {
    GET: { summary: 'View affiliate dashboard (public)', tags: ['Affiliates'] },
  },
}
