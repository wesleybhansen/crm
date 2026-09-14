import { renderDigestHtml, type DigestData, type DigestProse } from '../digest-render'

/* The weekly digest used to ask the model for a whole HTML document against a
 * 2,048 token ceiling. A real send hit the cap mid-tag and put
 * `<span style="font-size:` into a customer's inbox with the rest of the report
 * missing. The layout is ours now and the model only writes prose, so these
 * tests pin the two properties that failure violated: the report is always
 * complete, and model text can never become markup. */

const emptyWeek: DigestData = {
  forecastThisMonth: { deals: 0, weighted: 0 },
  periodDays: 7,
  newContacts: [],
  newContactCount: 0,
  dealsWon: [],
  dealsLost: [],
  wonValue: 0,
  lostValue: 0,
  emailsSent: 0,
  openRate: 0,
  submissionCount: 0,
  revenue: 0,
  coldContacts: [],
}

const busyWeek: DigestData = {
  ...emptyWeek,
  newContacts: [{ display_name: 'Dana Reyes', primary_email: 'd@example.com', source: 'website' }],
  newContactCount: 1,
  dealsWon: [{ title: 'Retainer', value: 4200 }],
  dealsLost: [{ title: 'One off', value: 900 }],
  wonValue: 4200,
  lostValue: 900,
  emailsSent: 40,
  openRate: 35,
  submissionCount: 3,
  revenue: 4200,
  coldContacts: [{ display_name: 'Sam Fox', score: 12 }],
  forecastThisMonth: { deals: 2, weighted: 6000 },
}

const prose: DigestProse = {
  status: 'Pipeline building',
  summary: 'One deal closed and forty emails went out.',
  suggestions: ['Follow up with Sam Fox.', 'Send the retainer invoice.', 'Book two calls.'],
}

describe('weekly digest rendering', () => {
  it('renders every KPI cell even on a week with no activity', () => {
    const html = renderDigestHtml(emptyWeek, null, 'Northstar Studio')
    for (const label of [
      'New contacts',
      'Revenue (invoices paid)',
      'Deals won / lost',
      'Emails sent',
      'Forecast this month',
      'Landing page submissions',
    ]) {
      expect(html).toContain(label)
    }
    // Six cells over three rows, so the grid never renders with a hole.
    expect(html.match(/<td /g)?.length).toBe(6)
    expect(html.match(/<tr>/g)?.length).toBe(3)
  })

  it('is a complete document even when the model returns nothing', () => {
    const html = renderDigestHtml(busyWeek, null, 'Northstar Studio')
    // The failure mode that shipped: an unclosed tag at the end of the body.
    expect(html.trim().endsWith('</div>')).toBe(true)
    expect(html.match(/</g)?.length).toBe(html.match(/>/g)?.length)
    // The numbers still carry the report without any model help.
    expect(html).toContain('$4,200')
    expect(html).toContain('1 won / 1 lost')
    expect(html).toContain('35% open rate')
  })

  it('escapes model prose so it can never become markup', () => {
    const hostile: DigestProse = {
      status: '<span style="font-size:',
      summary: 'Watch out <script>alert(1)</script> & friends',
      suggestions: ['<b>bold</b> move'],
    }
    const html = renderDigestHtml(busyWeek, hostile, 'Northstar Studio')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>bold</b>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp; friends')
    // The exact string from the broken send, now inert.
    expect(html).toContain('&lt;span style=&quot;font-size:')
    expect(html.match(/</g)?.length).toBe(html.match(/>/g)?.length)
  })

  it('escapes the business name too', () => {
    const html = renderDigestHtml(emptyWeek, prose, 'Ben & Co <script>')
    expect(html).toContain('Ben &amp; Co &lt;script&gt;')
    expect(html).not.toContain('Co <script>')
  })

  it('uses the model prose when it is there', () => {
    const html = renderDigestHtml(busyWeek, prose, 'Northstar Studio')
    expect(html).toContain('Status: Pipeline building')
    expect(html).toContain('One deal closed and forty emails went out.')
    expect(html).toContain('Follow up with Sam Fox.')
    expect(html).toContain('Suggested next week')
  })

  it('drops empty sections instead of printing an empty heading', () => {
    const html = renderDigestHtml(emptyWeek, { ...prose, suggestions: [] }, 'Northstar Studio')
    expect(html).not.toContain('Suggested next week')
    expect(html).not.toContain('Contacts going cold')
    expect(html).not.toContain('Deals won</h3>')
  })
})
