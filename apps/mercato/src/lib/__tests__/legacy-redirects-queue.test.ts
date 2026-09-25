/* QA 2026-09-25 (email batch): /queue returned 404. The review queue is the
 * Customer Service page's Queue tab, which reads ?tab= from the URL. */
import { legacyBackendRedirects, CUSTOMER_SERVICE_QUEUE_HOME } from '../legacy-redirects'
import { parseCustomerServiceTab } from '../../modules/customers/lib/customerServiceTabs'

describe('/queue redirect', () => {
  it('sends /queue to the Customer Service Queue tab', () => {
    const rule = legacyBackendRedirects().find((r) => r.source === '/queue')
    expect(rule).toEqual({ source: '/queue', destination: CUSTOMER_SERVICE_QUEUE_HOME, permanent: false })
    expect(CUSTOMER_SERVICE_QUEUE_HOME).toBe('/backend/customer-service?tab=queue')
  })

  it('lands on a tab the page understands', () => {
    const search = CUSTOMER_SERVICE_QUEUE_HOME.slice(CUSTOMER_SERVICE_QUEUE_HOME.indexOf('?'))
    expect(parseCustomerServiceTab(search)).toBe('queue')
  })
})
