/* QA 2026-09-25 #12/#13: /backend/todos 404'd and /backend/customers/people/import
 * was treated as a person id. Both go to the Contacts page. */
import { legacyBackendRedirects, TASKS_HOME, CONTACT_IMPORT_HOME } from '../legacy-redirects'

describe('contacts legacy redirects', () => {
  const bySource = new Map(legacyBackendRedirects().map((r) => [r.source, r]))

  it('sends /backend/todos to the Contacts Tasks tab', () => {
    expect(bySource.get('/backend/todos')).toEqual({ source: '/backend/todos', destination: TASKS_HOME, permanent: false })
    expect(TASKS_HOME).toBe('/backend/contacts?tab=tasks')
  })

  it('sends the people import path to the Contacts import pop-up', () => {
    expect(bySource.get('/backend/customers/people/import')?.destination).toBe(CONTACT_IMPORT_HOME)
    expect(CONTACT_IMPORT_HOME).toBe('/backend/contacts?import=1')
  })
})
