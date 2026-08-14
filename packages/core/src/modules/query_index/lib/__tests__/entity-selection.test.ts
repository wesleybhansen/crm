import { filterEntityIdsByModules } from '../entity-selection'

describe('filterEntityIdsByModules', () => {
  const entityIds = ['customers:customer_deal', 'example:todo', 'email:email_campaign']

  it('preserves all generated IDs when no module filter is supplied', () => {
    expect(filterEntityIdsByModules(entityIds)).toEqual(entityIds)
  })

  it('keeps only entities owned by enabled modules', () => {
    expect(filterEntityIdsByModules(entityIds, [' customers ', 'email'])).toEqual([
      'customers:customer_deal',
      'email:email_campaign',
    ])
  })
})
