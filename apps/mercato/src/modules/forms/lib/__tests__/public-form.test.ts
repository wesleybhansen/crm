/* The public form page and its submit route: invalid answers are refused on
 * the server before anything is stored, and the page script (built inside a
 * template string) is valid JavaScript with the email check intact. */

const fields = [
  { id: 'f_name', type: 'short_text', label: 'Name', required: true },
  { id: 'f_email', type: 'email', label: 'Email', required: true, crm_mapping: 'contact.email' },
]

const formRow = {
  id: 'form-1',
  tenant_id: 't1',
  organization_id: 'o1',
  name: 'QA form',
  slug: 'qa-form-abcd',
  status: 'published',
  is_active: true,
  fields: JSON.stringify(fields),
  settings: JSON.stringify({ createContact: true }),
  theme: '{}',
}

const inserts: Array<{ table: string; row: unknown }> = []

function makeKnex() {
  const knex: any = (table: string) => {
    const q: any = {
      where: () => q,
      first: async () => (table === 'forms' ? formRow : null),
      insert: async (row: unknown) => { inserts.push({ table, row }) },
      increment: async () => 1,
      update: async () => 1,
    }
    return q
  }
  knex.raw = async () => ({})
  return knex
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (key: string) => (key === 'em' ? { getKnex: () => makeKnex() } : {}),
  }),
}))
jest.mock('@/modules/customers/lib/contact-write', () => ({ createPersonContact: jest.fn() }))
jest.mock('@/modules/customers/lib/dedup', () => ({ findOrMergeContact: jest.fn(async () => ({ existing: null })) }))
jest.mock('@open-mercato/shared/lib/encryption/rawWrite', () => ({ encryptRowForRawWrite: jest.fn(async (_e: string, row: unknown) => row) }))
jest.mock('@/modules/customers/lib/engagement-score', () => ({ trackEngagement: jest.fn(async () => {}) }))
jest.mock('@/modules/customers/api/webhooks/dispatch', () => ({ dispatchWebhook: jest.fn(async () => {}) }))
jest.mock('@/modules/sequences/lib/automation-execute', () => ({ executeAutomationRules: jest.fn(async () => {}) }))
jest.mock('@/modules/sequences/services/sequence-triggers', () => ({ checkSequenceTriggers: jest.fn(async () => {}) }))

import { POST } from '../../api/public/[slug]/submit/route'
import { GET } from '../../api/public/[slug]/route'

function post(body: unknown) {
  return POST(new Request('http://localhost/api/forms/public/qa-form-abcd/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: { slug: 'qa-form-abcd' } })
}

describe('public form submit', () => {
  beforeEach(() => { inserts.length = 0 })

  it('refuses an invalid email with a 400 naming the field, and stores nothing', async () => {
    const res = await post({ f_name: 'Ada', f_email: 'notanemail' })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({ ok: false, field: 'f_email', error: 'Enter a valid email address, like name@example.com.' })
    expect(inserts).toHaveLength(0)
  })

  it('refuses a missing required field, and stores nothing', async () => {
    const res = await post({ f_email: 'ada@example.com' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ field: 'f_name', error: 'Name is required.' })
    expect(inserts).toHaveLength(0)
  })

  it('stores a valid submission', async () => {
    const res = await post({ f_name: 'Ada', f_email: 'ada@example.com' })
    expect(res.status).toBe(200)
    expect(inserts.some((i) => i.table === 'form_submissions')).toBe(true)
  })
})

describe('public form page', () => {
  it('renders 16px inputs and a valid script that checks emails before sending', async () => {
    const res = await GET(new Request('http://localhost/api/forms/public/qa-form-abcd'), { params: { slug: 'qa-form-abcd' } })
    const html = await res.text()
    expect(html).toMatch(/select, textarea \{[^}]*font-size: 16px/)
    const script = html.split('<script>')[1].split('</script>')[0]
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('var EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;')
    expect(script).toContain('if (!validateAll()) return;')
  })
})

describe('public form page script (in a DOM)', () => {
  async function mountPage() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JSDOM } = require('jsdom')
    const res = await GET(new Request('http://localhost/api/forms/public/qa-form-abcd'), { params: { slug: 'qa-form-abcd' } })
    const html = await res.text()
    const dom = new JSDOM(html.replace(/<script>[\s\S]*<\/script>/, ''), { url: 'http://localhost/', runScripts: 'outside-only' })
    const win = dom.window as any
    win.Element.prototype.scrollIntoView = () => {}
    win.fetch = jest.fn(() => new Promise(() => {}))
    const script = html.split('<script>')[1].split('</script>')[0]
    win.eval(script)
    return win
  }

  it('blocks an invalid email and shows the message next to the field', async () => {
    const win = await mountPage()
    const doc = win.document
    doc.querySelector('[name="f_name"]').value = 'Ada'
    doc.querySelector('[name="f_email"]').value = 'notanemail'
    doc.getElementById('formEl').dispatchEvent(new win.Event('submit', { cancelable: true }))
    expect(win.fetch).not.toHaveBeenCalled()
    const error = doc.querySelector('[name="f_email"]').closest('.field-full').querySelector('.field-error')
    expect(error?.textContent).toBe('Enter a valid email address, like name@example.com.')
  })

  it('sends once every field is valid', async () => {
    const win = await mountPage()
    const doc = win.document
    doc.querySelector('[name="f_name"]').value = 'Ada'
    doc.querySelector('[name="f_email"]').value = 'ada@example.com'
    doc.getElementById('formEl').dispatchEvent(new win.Event('submit', { cancelable: true }))
    expect(win.fetch).toHaveBeenCalledTimes(1)
  })
})
