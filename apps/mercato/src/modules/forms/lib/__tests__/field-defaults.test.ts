import { defaultCrmMappingFor } from '../field-defaults'

describe('defaultCrmMappingFor', () => {
  it('maps a new email field to the contact email', () => {
    expect(defaultCrmMappingFor('email', [])).toBe('contact.email')
  })
  it('leaves it unmapped when another field already fills the contact email', () => {
    expect(defaultCrmMappingFor('email', [{ crm_mapping: 'contact.email' }])).toBeUndefined()
  })
  it('leaves other field types unmapped', () => {
    expect(defaultCrmMappingFor('short_text', [])).toBeUndefined()
  })
})
