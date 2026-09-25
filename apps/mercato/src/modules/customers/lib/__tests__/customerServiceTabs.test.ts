import { customerServiceTabHref, parseCustomerServiceTab } from '../customerServiceTabs'

describe('parseCustomerServiceTab', () => {
  it('reads a known tab', () => {
    expect(parseCustomerServiceTab('?tab=accounts')).toBe('accounts')
    expect(parseCustomerServiceTab('?tab=Settings')).toBe('settings')
    expect(parseCustomerServiceTab('tab=queue&x=1')).toBe('queue')
  })
  it('falls back to Queue for missing or unknown tabs', () => {
    expect(parseCustomerServiceTab('')).toBe('queue')
    expect(parseCustomerServiceTab(null)).toBe('queue')
    expect(parseCustomerServiceTab('?tab=billing')).toBe('queue')
  })
})

describe('customerServiceTabHref', () => {
  it('sets tab and keeps other params and the hash', () => {
    expect(customerServiceTabHref('/backend/customer-service', '?x=1', '#kb', 'accounts'))
      .toBe('/backend/customer-service?x=1&tab=accounts#kb')
    expect(customerServiceTabHref('/backend/customer-service', '?tab=queue', '', 'settings'))
      .toBe('/backend/customer-service?tab=settings')
  })
})
