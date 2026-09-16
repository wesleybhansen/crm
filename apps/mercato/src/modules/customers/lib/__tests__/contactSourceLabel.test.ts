import { contactSourceLabel } from '../contactSourceLabel'

describe('contactSourceLabel', () => {
  it('rewrites the marketing category to a friendly, owner-facing label', () => {
    expect(contactSourceLabel('marketing')).toBe('From your marketing system')
  })

  it('rewrites a marketing category with a detail suffix the same way', () => {
    expect(contactSourceLabel('marketing:Free AI Readiness Guide')).toBe('From your marketing system')
  })

  it('leaves every other source category alone', () => {
    expect(contactSourceLabel('manual')).toBeNull()
    expect(contactSourceLabel('ai_assistant')).toBeNull()
    expect(contactSourceLabel('import')).toBeNull()
    expect(contactSourceLabel('api:my-key')).toBeNull()
  })

  it('handles missing sources without throwing', () => {
    expect(contactSourceLabel(null)).toBeNull()
    expect(contactSourceLabel(undefined)).toBeNull()
    expect(contactSourceLabel('')).toBeNull()
  })
})
