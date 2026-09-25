import { buildCustomerUrl } from '../search'

// MCP sweep 2026-09-25: a note whose contact could not be loaded (deleted)
// linked to /backend/customers/companies/<personId>. No link is better.
describe('buildCustomerUrl', () => {
  it('links people and companies to their own pages', () => {
    expect(buildCustomerUrl('person', 'p-1')).toBe('/backend/customers/people/p-1')
    expect(buildCustomerUrl('company', 'c-1')).toBe('/backend/customers/companies/c-1')
  })

  it('gives no link when the contact kind is unknown (contact gone)', () => {
    expect(buildCustomerUrl(null, 'p-1')).toBeNull()
    expect(buildCustomerUrl(undefined, 'p-1')).toBeNull()
    expect(buildCustomerUrl('person', null)).toBeNull()
  })
})
