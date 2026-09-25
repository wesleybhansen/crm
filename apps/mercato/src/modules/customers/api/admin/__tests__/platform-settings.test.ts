/* Admin panel 500s: platform_settings was read before any migration created
 * it. A missing table must read as "no cap" instead of failing the panel, and
 * saving the cap must upsert. */
import { query, queryOne } from '@/lib/db'

jest.mock('@/lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }))
jest.mock('../auth', () => ({ getAdminAuth: jest.fn(async () => ({ userId: 'root', email: 'root@noli.test' })) }))

import { GET as overview } from '../route'
import { GET as aiGet, PUT as aiPut } from '../ai/route'

const missingTable = Object.assign(new Error('relation "platform_settings" does not exist'), { code: '42P01' })

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.mocked(queryOne).mockImplementation(async (sql: string) => {
    if (sql.includes('platform_settings')) throw missingTable
    return { total: 3, total_calls: 7 }
  })
  jest.mocked(query).mockResolvedValue([{ org_id: 'o1', calls_used: 7 }])
})

describe('GET /admin', () => {
  it('loads with a null cap when platform_settings is missing', async () => {
    const res = await overview()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toMatchObject({ totalOrgs: 3, globalAiCap: null })
  })

  it('logs and returns a JSON 500 when a core query fails', async () => {
    jest.mocked(queryOne).mockRejectedValue(new Error('boom'))
    const res = await overview()
    expect(res.status).toBe(500)
    expect(console.error).toHaveBeenCalledWith('[admin.overview] failed', expect.any(Error))
  })
})

describe('/admin/ai', () => {
  it('GET loads with a null cap when platform_settings is missing', async () => {
    const res = await aiGet()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toMatchObject({ globalCap: null, totalCalls: 7, orgs: [{ org_id: 'o1' }] })
  })

  it('GET reads a numeric cap', async () => {
    jest.mocked(queryOne).mockImplementation(async (sql: string) =>
      sql.includes('platform_settings') ? { setting_value: '750' } : { total_calls: 1 })
    const json = await (await aiGet()).json()
    expect(json.data.globalCap).toBe(750)
  })

  it('PUT global upserts the cap', async () => {
    jest.mocked(query).mockResolvedValue([])
    const req = { json: async () => ({ type: 'global', cap: 900 }) }
    const res = await aiPut(req as never)
    expect(res.status).toBe(200)
    const [sql, params] = jest.mocked(query).mock.calls[0]!
    expect(String(sql)).toMatch(/ON CONFLICT \(setting_key\) DO UPDATE/)
    expect(params).toEqual(['global_ai_monthly_cap', '900'])
  })
})
