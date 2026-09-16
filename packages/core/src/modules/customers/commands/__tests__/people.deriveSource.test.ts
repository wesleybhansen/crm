import { deriveSourceFromInput } from '../people'

describe('deriveSourceFromInput', () => {
  it('recognizes the marketing category from the AMS-to-CRM channel', () => {
    expect(deriveSourceFromInput({ source: 'marketing' }, {})).toEqual({ category: 'marketing', detail: undefined })
  })

  it('accepts the ams and ams_marketing aliases', () => {
    expect(deriveSourceFromInput({ source: 'ams' }, {})).toEqual({ category: 'marketing', detail: undefined })
    expect(deriveSourceFromInput({ source: 'ams_marketing' }, {})).toEqual({ category: 'marketing', detail: undefined })
  })

  it('carries the landing page / lead magnet name as the detail', () => {
    expect(deriveSourceFromInput({ source: 'marketing', sourceDetail: 'Free AI Readiness Guide' }, {}))
      .toEqual({ category: 'marketing', detail: 'Free AI Readiness Guide' })
  })

  it('is case-insensitive and trims the raw source', () => {
    expect(deriveSourceFromInput({ source: '  Marketing  ' }, {})).toEqual({ category: 'marketing', detail: undefined })
  })

  it('leaves unrelated categories untouched', () => {
    expect(deriveSourceFromInput({ source: 'manual' }, {})).toEqual({ category: 'manual' })
    expect(deriveSourceFromInput({ source: 'ai_assistant' }, {})).toEqual({ category: 'ai_assistant' })
    expect(deriveSourceFromInput({}, {})).toEqual({ category: 'manual' })
  })
})
