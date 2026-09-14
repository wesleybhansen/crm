/* Rendering for the weekly business review email.
 *
 * Pure and free of server-only imports so the markup can be tested directly.
 * The model writes prose; everything structural is built here. */

export type DigestData = {
  forecastThisMonth: { deals: number; weighted: number }
  periodDays: number
  newContacts: Array<{ display_name: string; primary_email?: string | null; source?: string | null }>
  newContactCount: number
  dealsWon: Array<{ title: string; value: number }>
  dealsLost: Array<{ title: string; value: number }>
  wonValue: number
  lostValue: number
  emailsSent: number
  openRate: number
  submissionCount: number
  revenue: number
  coldContacts: Array<{ display_name: string; score: number }>
}

export type DigestProse = {
  status: string
  summary: string
  suggestions: string[]
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

function kpiCell(label: string, value: string, note?: string): string {
  return `<td style="padding:16px 18px;border:1px solid #e6e8ec;vertical-align:top;width:50%;">
      <div style="font-size:13px;color:#6b7280;letter-spacing:.02em;">${escapeHtml(label)}</div>
      <div style="font-size:26px;font-weight:700;color:#111827;line-height:1.2;margin-top:4px;">${escapeHtml(value)}</div>
      ${note ? `<div style="font-size:12px;color:#9ca3af;margin-top:2px;">${escapeHtml(note)}</div>` : ''}
    </td>`
}

function listSection(title: string, items: string[]): string {
  if (items.length === 0) return ''
  return `<h3 style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:28px 0 10px;">${escapeHtml(title)}</h3>
    <ul style="margin:0;padding-left:20px;color:#374151;font-size:15px;line-height:1.65;">
      ${items.map(i => `<li style="margin-bottom:6px;">${escapeHtml(i)}</li>`).join('')}
    </ul>`
}

/* The report itself: our markup, our numbers, the model's words where they add
 * something. Every KPI cell is rendered whether or not it has a value, so the
 * grid can never come out with a hole in it. */
export function renderDigestHtml(data: DigestData, prose: DigestProse | null, businessName: string): string {
  const periodLabel = data.periodDays === 7 ? 'Last 7 days' : `Last ${data.periodDays} days`
  const dealsLine = `${data.dealsWon.length} won / ${data.dealsLost.length} lost`
  const dealsNote = data.dealsWon.length + data.dealsLost.length > 0
    ? `${money(data.wonValue)} won, ${money(data.lostValue)} lost`
    : 'No deals closed this period'

  const status = prose?.status ?? (data.newContactCount + data.dealsWon.length + data.emailsSent === 0 ? 'Quiet week' : 'This week')
  const summary = prose?.summary
    ?? 'This is the record of what the system captured this period. The written summary could not be generated this time, so the numbers below stand on their own.'

  const rows = [
    [kpiCell('New contacts', String(data.newContactCount)), kpiCell('Revenue (invoices paid)', money(data.revenue))],
    [kpiCell('Deals won / lost', dealsLine, dealsNote), kpiCell('Emails sent', String(data.emailsSent), `${data.openRate}% open rate`)],
    [
      kpiCell('Forecast this month', money(data.forecastThisMonth.weighted), `${data.forecastThisMonth.deals} open deal${data.forecastThisMonth.deals === 1 ? '' : 's'}, weighted`),
      kpiCell('Landing page submissions', String(data.submissionCount)),
    ],
  ]

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827;">
  <div style="font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#4f46e5;">${escapeHtml(businessName)} &bull; Business review</div>
  <h1 style="font-size:28px;font-weight:700;margin:10px 0 6px;line-height:1.2;">Weekly performance report</h1>
  <div style="font-size:15px;color:#6b7280;">Period: ${escapeHtml(periodLabel)}</div>
  <hr style="border:none;border-top:1px solid #e6e8ec;margin:22px 0;" />

  <div style="border-left:3px solid #4f46e5;background:#f8f9fb;padding:16px 18px;border-radius:0 8px 8px 0;">
    <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Status: ${escapeHtml(status)}</div>
    <div style="font-size:15px;line-height:1.65;color:#374151;">${escapeHtml(summary)}</div>
  </div>

  <h3 style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:28px 0 10px;">Key performance indicators</h3>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
    ${rows.map(cells => `<tr>${cells.join('')}</tr>`).join('')}
  </table>

  ${listSection('Contacts going cold', data.coldContacts.map(c => `${c.display_name} (engagement score ${c.score})`))}
  ${listSection('Deals won', data.dealsWon.map(d => `${d.title} — ${money(d.value)}`))}
  ${listSection('Suggested next week', prose?.suggestions ?? [])}

  <hr style="border:none;border-top:1px solid #e6e8ec;margin:28px 0 14px;" />
  <div style="font-size:12px;color:#9ca3af;line-height:1.6;">Prepared by your Chief of Staff from your CRM records for the ${escapeHtml(periodLabel.toLowerCase())}. Nothing was sent or changed to produce it.</div>
</div>`
}


