import { enrichContactFromSignature } from '../signature-enrichment'

/**
 * primary_phone and job_title are encrypted-by-design columns. Signature
 * enrichment writes them with raw UPDATEs, so it must hand the database the
 * encrypted values (and the phone lookup hash), never the parsed plaintext.
 * It wrote plaintext until 2026-09-24.
 */
describe('enrichContactFromSignature', () => {
  const orgId = 'org-1'
  const contactId = 'contact-1'

  function harness(current: Record<string, unknown>) {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const query = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      if (/^\s*SELECT ce\.tenant_id/.test(sql)) return { rows: [current] }
      if (/SELECT company_name_hint/.test(sql)) return { rows: [{ company_name_hint: null }] }
      return { rows: [] }
    }
    const encryptRow = jest.fn(async (entityId: string, row: Record<string, unknown>, tenantId: string, org: string) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) out[k] = `enc(${entityId}|${tenantId}|${org}|${v})`
      if ('primary_phone' in row) out.primary_phone_hash = 'hash(phone)'
      return out
    })
    const syncSearch = jest.fn(async (_source: string, _scope: Record<string, unknown>, _values: Record<string, unknown>) => {})
    return { calls, query, encryptRow, syncSearch }
  }

  it('writes the phone and job title encrypted, with the phone lookup hash', async () => {
    const h = harness({ tenant_id: 'tenant-1', primary_phone: null, job_title: null, linkedin_url: null })
    const filled = await enrichContactFromSignature(h.query, orgId, contactId, { phone: '+1 555 010 0100', jobTitle: 'Founder' }, h.encryptRow, h.syncSearch)
    expect(filled).toEqual(['phone', 'job title'])

    const phone = h.calls.find((c) => /UPDATE customer_entities SET primary_phone/.test(c.sql))!
    expect(phone.params).toEqual(['enc(customers:customer_entity|tenant-1|org-1|+1 555 010 0100)', 'hash(phone)', contactId, orgId])
    expect(phone.sql).toMatch(/primary_phone_hash = \$2/)

    const title = h.calls.find((c) => /UPDATE customer_people SET job_title/.test(c.sql))!
    expect(title.params[0]).toBe('enc(customers:customer_person_profile|tenant-1|org-1|Founder)')

    for (const call of h.calls) {
      expect(call.params).not.toContain('+1 555 010 0100')
      expect(call.params).not.toContain('Founder')
    }

    // The raw UPDATEs bypass the ORM, so the blind search index is refreshed
    // for exactly the fields written (hashes are computed there, never stored in clear).
    const scope = { tenantId: 'tenant-1', organizationId: orgId, entityType: 'person', entityId: contactId }
    expect(h.syncSearch).toHaveBeenCalledWith('customers:customer_entity', scope, { primary_phone: '+1 555 010 0100' })
    expect(h.syncSearch).toHaveBeenCalledWith('customers:customer_person_profile', scope, { job_title: 'Founder' })
  })

  it('never overwrites a value the contact already has (ciphertext counts as present)', async () => {
    const h = harness({ tenant_id: 'tenant-1', primary_phone: 'iv:ct:tag:v2:0011aabb', job_title: 'iv:ct:tag:v2:0011aabb', linkedin_url: 'x' })
    const filled = await enrichContactFromSignature(h.query, orgId, contactId, { phone: '+1 555 010 0100', jobTitle: 'Founder' }, h.encryptRow, h.syncSearch)
    expect(filled).toEqual([])
    expect(h.encryptRow).not.toHaveBeenCalled()
    expect(h.syncSearch).not.toHaveBeenCalled()
  })

  it('writes nothing when encryption fails', async () => {
    const h = harness({ tenant_id: 'tenant-1', primary_phone: null, job_title: null, linkedin_url: null })
    h.encryptRow.mockRejectedValueOnce(new Error('key service down'))
    await expect(enrichContactFromSignature(h.query, orgId, contactId, { phone: '+1 555 010 0100' }, h.encryptRow, h.syncSearch)).rejects.toThrow('key service down')
    expect(h.syncSearch).not.toHaveBeenCalled()
    expect(h.calls.some((c) => /^\s*UPDATE/.test(c.sql))).toBe(false)
  })
})
