import { companySourceFromInput } from '../companies'

describe('companySourceFromInput', () => {
  it('keeps an explicit source', () => {
    expect(companySourceFromInput(' referral ', {})).toBe('referral')
  })

  it('defaults to manual like the person form, or api for API keys', () => {
    expect(companySourceFromInput(undefined, {})).toBe('manual')
    expect(companySourceFromInput('', {})).toBe('manual')
    expect(companySourceFromInput(null, { auth: { isApiKey: true, keyName: 'Zapier' } })).toBe('api:Zapier')
    expect(companySourceFromInput(null, { auth: { isApiKey: true } })).toBe('api')
  })
})
