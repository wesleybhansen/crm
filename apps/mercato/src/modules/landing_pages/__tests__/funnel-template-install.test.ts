/**
 * "Use This Template" on a funnel used to publish a public landing page with
 * placeholder copy while the funnel editor showed "Select a page...".
 * Template pages are now drafts, linked to their step, and publishable.
 */
import { query, queryOne } from '@/lib/db'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

jest.mock('@/lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({ getAuthFromCookies: jest.fn() }))

import { POST as installTemplate } from '../api/funnels/templates/route'
import { renderWizardPageHtml } from '../services/wizard-publish'

const tenantId = '66666666-6666-4666-8666-666666666666'
const orgId = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(getAuthFromCookies).mockResolvedValue({ sub: 'u', tenantId, orgId, roles: [] } as any)
  jest.mocked(query).mockResolvedValue([] as any)
  jest.mocked(queryOne).mockResolvedValue({ id: 'funnel' } as any)
})

it('creates the Lead Magnet page as a linked draft', async () => {
  const res = await installTemplate(new Request('http://localhost/x', {
    method: 'POST',
    body: JSON.stringify({ templateId: 'lead-magnet' }),
  }))
  expect(res.status).toBe(201)
  const body = await res.json()

  const calls = jest.mocked(query).mock.calls
  const pageInsert = calls.find(([sql]) => String(sql).startsWith('INSERT INTO landing_pages'))!
  const pageParams = pageInsert[1] as unknown[]
  const [pageId] = pageParams
  expect(pageParams[7]).toBe('draft') // status
  expect(pageParams[9]).toBeNull() // no published_html
  expect(pageParams[14]).toBeNull() // no published_at

  const config = JSON.parse(String(pageParams[8]))
  expect(config.generatedSections).toHaveLength(1)
  expect(config.generatedSections[0]).toMatchObject({ type: 'hero', headline: 'Free Resource' })

  // The funnel step points at the page, so the editor can show it.
  const stepInserts = calls.filter(([sql]) => String(sql).startsWith('INSERT INTO funnel_steps'))
  expect((stepInserts[0][1] as unknown[])[4]).toBe(pageId)

  expect(body.data.createdPages).toEqual([{ id: pageId, title: 'Free Resource', status: 'draft' }])

  // And the starter page renders when the user publishes it.
  const html = renderWizardPageHtml(config, { title: 'Free Resource', slug: 'lm' }, '/submit')
  expect(html).toContain('Free Resource')
  expect(html).toContain('Send Me the Guide')
})
