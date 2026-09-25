/**
 * Regression: AI-wizard landing pages could not be published (QA 2026-09-24).
 * POST /api/landing_pages/pages/{id}/publish answered 400 "Could not generate
 * page HTML" for a page whose config held 6 generatedSections, and the editor
 * showed no sections. The page's own form row was inserted without the NOT
 * NULL tenant_id / organization_id columns; the error was swallowed and the
 * rendered HTML discarded.
 */
import { query, queryOne } from '@/lib/db'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

jest.mock('@/lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({ getAuthFromCookies: jest.fn() }))

import { POST as publish } from '../api/pages/[id]/publish/route'
import { GET as getSections, PUT as putSections } from '../api/pages/[id]/sections/route'
import {
  editorSectionsToGeneratedSections,
  generatedSectionsToEditorSections,
  renderWizardPageHtml,
  type WizardConfig,
} from '../services/wizard-publish'

const tenantId = '66666666-6666-4666-8666-666666666666'
const orgId = '11111111-1111-4111-8111-111111111111'
const pageId = '33333333-3333-4333-8333-333333333333'

/** The shape Step7PreviewPublish stores for the QA run (waitlist, Clean & Minimal). */
function wizardConfig(overrides: Partial<WizardConfig> = {}): WizardConfig {
  return {
    wizardVersion: 2,
    pageType: 'capture-leads',
    subType: 'waitlist',
    framework: 'PAS',
    businessContext: {
      businessName: '[e2e] QA Co',
      targetAudience: 'Engineering teams',
      tone: 'professional',
      offerAnswers: { offerName: '[e2e] QA waitlist', earlyAccess: 'Founder pricing' },
    } as any,
    generatedSections: [
      {
        type: 'hero',
        headline: 'Fix costly test flaws before your next sprint',
        headlineVariants: ['Fix costly test flaws before your next sprint', 'Ship without the flaky tests'],
        selectedHeadline: 0,
        subtitle: 'Join the waitlist for early access and founder pricing.',
        ctaText: 'Join the waitlist',
        ctaVariants: ['Join the waitlist', 'Get early access'],
        selectedCta: 0,
      },
      { type: 'pain-points', headline: 'Sound familiar?', items: [{ title: 'Flaky tests', description: 'Red builds for no reason.' }, { title: 'Slow reviews' } as any] },
      { type: 'features-benefits', headline: 'What you get', items: [{ title: 'Founder pricing', description: 'Locked for life.' }] },
      // The AI sometimes answers testimonials with a different item shape.
      { type: 'testimonials', headline: 'What Our Customers Say', items: [{ quote: 'Great', name: 'Dana' } as any] },
      { type: 'faq', headline: 'Questions', faqItems: [{ question: 'When does it launch?', answer: 'Soon.' }, { question: 'Is it free?' } as any] },
      { type: 'cta-block', headline: 'Save your spot', ctaText: 'Join the waitlist' },
    ],
    styleId: 'minimal',
    styleVariant: 0,
    formFields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Email', type: 'email', required: true },
    ],
    metaTitle: 'QA waitlist',
    metaDescription: 'Early access',
    thankYouHeadline: "You're on the list!",
    thankYouMessage: "We'll email you when it's ready.",
    pipelineStage: 'Prospect',
    bookingPageSlug: null,
    leadMagnet: null,
    productId: null,
    heroImageUrl: null,
    simpleLayout: false,
    ...overrides,
  }
}

function pageRow(config: WizardConfig) {
  return {
    id: pageId,
    tenant_id: tenantId,
    organization_id: orgId,
    title: '[e2e] QA Co - [e2e] QA waitlist',
    slug: 'e2e-qa-co-ra5g2',
    status: 'draft',
    template_id: null,
    published_html: null,
    config: JSON.stringify(config),
  }
}

const params = { params: Promise.resolve({ id: pageId }) }
const mockQuery = jest.mocked(query)
const mockQueryOne = jest.mocked(queryOne)

beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(getAuthFromCookies).mockResolvedValue({ sub: 'user-1', tenantId, orgId, roles: [] } as any)
  mockQuery.mockResolvedValue([] as any)
})

describe('renderWizardPageHtml', () => {
  it('renders the stored wizard config with waitlist wording', () => {
    const html = renderWizardPageHtml(wizardConfig(), { title: 'QA waitlist', slug: 'qa' }, '/submit')
    expect(html).toContain('Fix costly test flaws before your next sprint')
    expect(html).toContain('Join the Waitlist')
    expect(html).toContain('Save your spot')
    expect(html).toContain("You&#39;re on the list!")
    expect(html).not.toMatch(/Free Resource/i)
    expect(html).not.toContain('Download Free Guide')
  })

  it('keeps lead-magnet wording for a free guide', () => {
    const config = wizardConfig({ subType: 'free-guide' })
    config.generatedSections![0] = { ...config.generatedSections![0], ctaText: undefined, ctaVariants: undefined, selectedCta: undefined }
    const html = renderWizardPageHtml(config, { title: 'Guide', slug: 'guide' }, '/submit')
    expect(html).toContain('Free Guide')
    expect(html).toContain('Download Free Guide')
  })

  it('falls back to the default style for an unknown style id', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => renderWizardPageHtml(wizardConfig({ styleId: 'nope' }), { title: 't', slug: 's' }, '/x')).not.toThrow()
    warn.mockRestore()
  })

  it('says why when there is nothing to render', () => {
    expect(() => renderWizardPageHtml(wizardConfig({ generatedSections: [] }), { title: 't', slug: 's' }, '/x'))
      .toThrow(/no generated sections/)
  })
})

describe('editor <-> wizard sections', () => {
  it('round-trips and lets an edited headline win over the chosen variant', () => {
    const sections = wizardConfig().generatedSections!
    const editor = generatedSectionsToEditorSections(sections)
    expect(editor).toHaveLength(6)
    expect(editor[0]).toMatchObject({ id: 'section-0', type: 'hero', fields: { headline: sections[0].headline } })

    editor[0].fields.headline = 'My own headline'
    const back = editorSectionsToGeneratedSections(editor)
    expect(back[0].type).toBe('hero')
    expect(back[0].selectedHeadline).toBeUndefined()
    const html = renderWizardPageHtml(wizardConfig({ generatedSections: back }), { title: 't', slug: 's' }, '/x')
    expect(html).toContain('My own headline')
  })
})

describe('POST /api/landing_pages/pages/{id}/publish (wizard page)', () => {
  it('publishes, writes the form row with tenant and organization, and keeps the Forms copy a draft', async () => {
    const config = wizardConfig()
    mockQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM landing_pages')) return pageRow(config)
      return null // no existing forms / landing_page_forms / slug clash
    })

    const res = await publish(new Request(`http://localhost/api/landing_pages/pages/${pageId}/publish`, { method: 'POST' }), params)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.createdForm).toMatchObject({ status: 'draft' })

    const lpFormInsert = mockQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO landing_page_forms'))
    expect(lpFormInsert).toBeDefined()
    expect(String(lpFormInsert![0])).toMatch(/tenant_id, organization_id/)
    expect(lpFormInsert![1]).toEqual(expect.arrayContaining([tenantId, orgId, pageId]))

    const formsInsert = mockQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO forms'))
    expect(String(formsInsert![0])).toContain("'draft', false")

    const publishUpdate = mockQuery.mock.calls.find(([sql]) => String(sql).includes('SET published_html'))
    expect(publishUpdate).toBeDefined()
    expect(String(publishUpdate![1]![0])).toContain('Fix costly test flaws before your next sprint')
  })

  it('still publishes when the optional Forms copy cannot be saved', async () => {
    const config = wizardConfig()
    mockQueryOne.mockImplementation(async (sql: string) => (sql.includes('FROM landing_pages') ? pageRow(config) : null))
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO forms')) throw new Error('relation "forms" does not exist')
      return [] as any
    })
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})

    const res = await publish(new Request('http://localhost/x', { method: 'POST' }), params)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.createdForm).toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('sections API for wizard pages', () => {
  it('returns the generated sections to the editor', async () => {
    const config = wizardConfig()
    mockQueryOne.mockResolvedValue(pageRow(config) as any)
    const res = await getSections(new Request('http://localhost/x'), params)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.sections).toHaveLength(6)
    expect(body.data.sections[0].fields.headline).toBe('Fix costly test flaws before your next sprint')
  })

  it('saves editor sections back into generatedSections', async () => {
    const config = wizardConfig()
    mockQueryOne.mockResolvedValue(pageRow(config) as any)
    const sections = generatedSectionsToEditorSections(config.generatedSections!).slice(0, 2)
    const res = await putSections(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify({ sections }) }), params)
    expect((await res.json()).ok).toBe(true)
    const saved = JSON.parse(String(mockQuery.mock.calls[0]![1]![0]))
    expect(saved.generatedSections).toHaveLength(2)
    expect(saved.sections).toBeUndefined()
  })

  it('refuses to save an empty section list over a wizard page', async () => {
    mockQueryOne.mockResolvedValue(pageRow(wizardConfig()) as any)
    const res = await putSections(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify({ sections: [] }) }), params)
    expect(res.status).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
