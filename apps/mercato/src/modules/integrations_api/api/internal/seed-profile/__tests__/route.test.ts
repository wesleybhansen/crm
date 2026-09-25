/** @jest-environment node */

const mockExecute = jest.fn()
const mockFindOne = jest.fn()
const mockFlush = jest.fn()
const mockPersistAndFlush = jest.fn()

class MockProfile {}
class MockTemplate {
  [k: string]: unknown
}

jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({
  findNoliUserById: async () => ({ id: 'noli-1', clerk_user_id: 'clerk-1' }),
}))
jest.mock('@open-mercato/shared/lib/auth/clerk', () => ({
  resolveClerkUserToAuthContext: async () => ({ userId: 'user-1', orgId: ORG, tenantId: TENANT }),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (name: string) =>
      name === 'em'
        ? { fork: () => ({ findOne: mockFindOne, flush: mockFlush, persistAndFlush: mockPersistAndFlush }) }
        : { execute: mockExecute },
  }),
}))
jest.mock('@open-mercato/core/modules/customers/data/entities', () => ({ CustomerBusinessProfile: MockProfile }))
jest.mock('@open-mercato/core/modules/customers/data/validators', () => ({
  businessProfileUpsertSchema: { parse: (x: unknown) => x },
}))
jest.mock('@/modules/email/data/schema', () => ({ EmailTemplate: MockTemplate }))
jest.mock('@/modules/gtm/lib/flags', () => ({ gtmEnabled: () => false }))

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'

import { POST } from '../route'
import { buildCrmFirstValueDraft, buildNoliOnboardingSeed } from '../../../../lib/onboarding-seed'
import { renderFirstValueHtml } from '../../../../lib/lab-refresh'

const OLD = {
  businessName: 'The 24-Hour WH-347 Pass/Fix Review',
  businessDescription: 'Certified payroll review for subcontractors',
  idealClients: 'Commercial specialty subcontractors',
}
const NEW = {
  businessName: 'Clinic Books',
  businessDescription: 'Bookkeeping for independent vet clinics',
  customers: 'Independent veterinary clinics in Phoenix',
}

function existingProfile(extra: Record<string, unknown> = {}) {
  return {
    ...OLD,
    pipelineStages: [{ name: 'Lead' }, { name: 'Won' }],
    socialLinks: { linkedin: 'https://linkedin.com/in/me' },
    websiteUrl: 'https://mine.example',
    aiPersonaName: 'Quinn',
    onboardingComplete: true,
    seededBy: 'launchpad-lab',
    seededReviewedAt: new Date('2026-09-24T00:00:00Z'),
    ...extra,
  }
}

function oldSeedTemplate() {
  const draft = buildCrmFirstValueDraft(buildNoliOnboardingSeed(OLD))
  return { subject: draft.subject, bodyHtml: renderFirstValueHtml(draft) }
}

function request(body: Record<string, unknown>) {
  process.env.NOLI_INTERNAL_SERVICE_SECRET = 's3cret'
  return new Request('http://crm.test/api/internal/seed-profile', {
    method: 'POST',
    headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
    body: JSON.stringify({ noliUserId: 'noli-1', ...body }),
  })
}

function setup(profile: unknown, template: unknown) {
  mockFindOne.mockImplementation(async (entity: unknown) => (entity === MockProfile ? profile : template))
}

function written(): Record<string, unknown> {
  const call = mockExecute.mock.calls.find((c) => c[0] === 'customers.business_profile.upsert')
  return call ? (call[1] as { input: Record<string, unknown> }).input : {}
}

describe('internal seed-profile: the Lab is authoritative for the idea', () => {
  beforeEach(() => jest.clearAllMocks())

  it('replaces the idea fields from a Lab seed and leaves the member settings alone', async () => {
    setup(existingProfile(), null)
    const res = await POST(request({
      source: 'launchpad-lab',
      ...NEW,
      businessDescription: NEW.businessDescription,
      idealClients: NEW.customers,
      websiteUrl: '',
      pipelineStages: ['Other'],
      socialLinks: { x: 'https://x.com/other' },
      cosName: 'Noli',
    }))
    expect(res.status).toBe(200)
    const input = written()
    expect(input).toEqual(expect.objectContaining({
      tenantId: TENANT,
      organizationId: ORG,
      businessName: 'Clinic Books',
      businessDescription: 'Bookkeeping for independent vet clinics',
      idealClients: 'Independent veterinary clinics in Phoenix',
      seededBy: 'launchpad-lab',
      seededReviewedAt: null,
    }))
    for (const key of ['pipelineStages', 'socialLinks', 'websiteUrl', 'aiPersonaName']) expect(input).not.toHaveProperty(key)
  })

  it('never blanks an idea field when the Lab sends it empty', async () => {
    setup(existingProfile(), null)
    await POST(request({ source: 'launchpad-lab', businessName: '', businessDescription: NEW.businessDescription }))
    const input = written()
    expect(input).not.toHaveProperty('businessName')
    expect(input.businessDescription).toBe(NEW.businessDescription)
  })

  it('uses the Lab audience when it sends no customers line', async () => {
    setup(existingProfile(), null)
    await POST(request({ source: 'launchpad-lab', ...NEW, customers: '', audience: 'Vet clinic owners' }))
    expect(written().idealClients).toBe('Vet clinic owners')
  })

  it('keeps fill-blanks-only for the hub and onboarding sources', async () => {
    setup(existingProfile({ seededBy: 'noli-hub' }), null)
    await POST(request({ ...NEW, idealClients: NEW.customers }))
    expect(mockExecute).not.toHaveBeenCalled()
    setup(existingProfile({ seededBy: 'noli-hub' }), null)
    await POST(request({ source: 'something-else', ...NEW, idealClients: NEW.customers }))
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('reads the profile and template for the member org and tenant only', async () => {
    setup(existingProfile(), null)
    await POST(request({ source: 'launchpad-lab', ...NEW }))
    for (const [, where] of mockFindOne.mock.calls) {
      expect(where).toEqual(expect.objectContaining({ organizationId: ORG, tenantId: TENANT }))
    }
  })

  it('regenerates an unedited seeded follow-up template from the new idea', async () => {
    const tpl = oldSeedTemplate()
    setup(existingProfile(), tpl)
    const res = await POST(request({ source: 'launchpad-lab', ...NEW }))
    expect(mockFlush).toHaveBeenCalled()
    expect(tpl.subject).toBe('A quick follow-up from Clinic Books')
    expect(tpl.bodyHtml).toMatch(/Independent veterinary clinics in Phoenix/)
    expect(tpl.bodyHtml).toMatch(/noli:first-value-sha:/)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({ updated: true }))

    // A later Lab seed recognises its own fingerprinted draft as unedited.
    setup(existingProfile({ ...NEW, idealClients: NEW.customers }), tpl)
    await POST(request({ source: 'launchpad-lab', businessName: 'Clinic Books Pro', businessDescription: NEW.businessDescription, customers: NEW.customers }))
    expect(tpl.subject).toBe('A quick follow-up from Clinic Books Pro')
  })

  it('leaves a follow-up template the member edited', async () => {
    const tpl = oldSeedTemplate()
    tpl.bodyHtml = tpl.bodyHtml.replace('Would a short conversation', 'Could we talk')
    const before = { ...tpl }
    setup(existingProfile(), tpl)
    await POST(request({ source: 'launchpad-lab', ...NEW }))
    expect(tpl).toEqual(before)

    const fingerprinted = oldSeedTemplate()
    setup(existingProfile(), fingerprinted)
    await POST(request({ source: 'launchpad-lab', ...NEW }))
    const edited = { subject: 'My own subject', bodyHtml: fingerprinted.bodyHtml }
    setup(existingProfile({ businessName: 'Clinic Books' }), edited)
    await POST(request({ source: 'launchpad-lab', businessName: 'Clinic Books Two', businessDescription: 'x' }))
    expect(edited.subject).toBe('My own subject')
  })

  it('never rewrites the template for a non-Lab seed', async () => {
    const tpl = oldSeedTemplate()
    const before = { ...tpl }
    setup(existingProfile({ seededBy: 'noli-hub' }), tpl)
    await POST(request({ ...NEW }))
    expect(tpl).toEqual(before)
  })
})
