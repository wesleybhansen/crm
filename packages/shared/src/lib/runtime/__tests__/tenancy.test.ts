import {
  isBlockedByMaintenance,
  isMaintenanceMode,
  isTenantPerCustomerEnabled,
  templateTenantId,
} from '../tenancy'

describe('tenancy runtime switches', () => {
  it('per-customer tenants are off unless explicitly enabled', () => {
    expect(isTenantPerCustomerEnabled({})).toBe(false)
    expect(isTenantPerCustomerEnabled({ CRM_TENANT_PER_CUSTOMER: '0' })).toBe(false)
    expect(isTenantPerCustomerEnabled({ CRM_TENANT_PER_CUSTOMER: 'maybe' })).toBe(false)
    expect(isTenantPerCustomerEnabled({ CRM_TENANT_PER_CUSTOMER: '1' })).toBe(true)
    expect(isTenantPerCustomerEnabled({ CRM_TENANT_PER_CUSTOMER: 'true' })).toBe(true)
  })

  it('maintenance blocks writes only, and only when set', () => {
    expect(isMaintenanceMode({})).toBe(false)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(isBlockedByMaintenance(method, { MAINTENANCE: '1' })).toBe(true)
      expect(isBlockedByMaintenance(method, {})).toBe(false)
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isBlockedByMaintenance(method, { MAINTENANCE: '1' })).toBe(false)
    }
  })

  it('template tenant id must be a uuid', () => {
    expect(templateTenantId({})).toBeNull()
    expect(templateTenantId({ CRM_TENANT_TEMPLATE_ID: 'nope' })).toBeNull()
    expect(templateTenantId({ CRM_TENANT_TEMPLATE_ID: ' 22560ECC-AC23-466A-B047-0B8F23A259FF ' })).toBe('22560ecc-ac23-466a-b047-0b8f23a259ff')
  })
})
