import { projectCosMetrics } from '../cos-metrics'

describe('projectCosMetrics', () => {
  it('projects bounded aggregate counts from PostgreSQL count strings', () => {
    expect(
      projectCosMetrics(
        { total_deals: '7', open_deals: '3' },
        { total_contacts: '14' },
      ),
    ).toEqual({ openDeals: 3, totalDeals: 7, totalContacts: 14 })
  })

  it.each([
    [{ total_deals: '7', open_deals: '8' }, { total_contacts: '14' }],
    [{ total_deals: '-1', open_deals: '0' }, { total_contacts: '14' }],
    [{ total_deals: '7', open_deals: 'NaN' }, { total_contacts: '14' }],
    [{ total_deals: '7', open_deals: '3' }, { total_contacts: null }],
  ])('refuses ambiguous or impossible database projections', (deals, contacts) => {
    expect(() => projectCosMetrics(deals, contacts)).toThrow('cos_metrics_unavailable')
  })
})
