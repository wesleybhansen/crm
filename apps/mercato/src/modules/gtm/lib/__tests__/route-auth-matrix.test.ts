import { readdirSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  HARNESS_SECRET,
  bearer,
  harness,
  internalRequest,
  readJson,
  resetHarness,
} from './support/route-harness'

jest.mock('@open-mercato/shared/lib/noli/core-client', () =>
  require('./support/route-harness').coreClientMock,
)
jest.mock('@open-mercato/shared/lib/auth/clerk', () => require('./support/route-harness').clerkMock)
jest.mock('@open-mercato/shared/lib/di/container', () =>
  require('./support/route-harness').containerMock,
)

/*
 * Behavioural auth matrix for every internal GTM route (review M14: the
 * previous contract test grepped route source for the string
 * 'hasGtmFeature', which cannot fail for a route that checks the feature on
 * one op and skips another). Each route handler is invoked for real:
 *
 *   - no Authorization header                 -> 401
 *   - wrong bearer, same byte length          -> 401
 *   - multibyte bearer, same UTF-16 length    -> 401 (used to throw: L1)
 *   - valid bearer, represented user with NO
 *     GTM features, one valid body per op     -> 403 Forbidden
 *
 * Bodies are generated from each route's zod validator so a newly added op
 * is covered automatically; the only hand-written overrides are fields a
 * refinement requires beyond the schema shape.
 */

const UUID = '12345678-1234-4123-8123-123456789abc'

type ZodDef = {
  type: string
  shape?: Record<string, z.ZodType>
  options?: z.ZodType[]
  values?: unknown[]
  entries?: Record<string, unknown>
  innerType?: z.ZodType
  in?: z.ZodType
  checks?: Array<{ _zod: { def: Record<string, unknown> } }>
  element?: z.ZodType
}

function defOf(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def
}

function checksOf(def: ZodDef): Array<Record<string, unknown>> {
  return (def.checks ?? []).map((check) => check._zod.def)
}

function minimalString(key: string, def: ZodDef): string {
  if (/(^id$|Ids?$|_id$)/.test(key)) return UUID
  let minLength = 1
  for (const check of checksOf(def)) {
    if (check.check === 'min_length' && typeof check.minimum === 'number') {
      minLength = Math.max(minLength, check.minimum)
    }
    if (check.check === 'string_format') {
      if (check.format === 'url') return 'https://example.com/path'
      if (check.format === 'uuid') return UUID
      if (check.format === 'datetime') return '2026-09-02T12:00:00.000Z'
      if (check.format === 'email') return 'someone@fixture.example'
      if (check.format === 'regex') {
        const source = String(check.pattern)
        if (source.includes('[a-f0-9]{64}')) return 'a'.repeat(64)
        if (source.includes('<')) return '<message-id@fixture.example>'
      }
    }
  }
  return 'x'.repeat(Math.max(minLength, 1))
}

function minimalNumber(def: ZodDef): number {
  let value = 1
  for (const check of checksOf(def)) {
    if (check.check === 'greater_than' && typeof check.value === 'number') {
      value = Math.max(value, check.inclusive ? check.value : check.value + 1)
    }
  }
  return Math.ceil(value)
}

function minimalFor(schema: z.ZodType, key = ''): unknown {
  const def = defOf(schema)
  switch (def.type) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [field, fieldSchema] of Object.entries(def.shape ?? {})) {
        const fieldDef = defOf(fieldSchema)
        if (fieldDef.type === 'optional' || fieldDef.type === 'default') continue
        out[field] = minimalFor(fieldSchema, field)
      }
      return out
    }
    case 'string':
      return minimalString(key, def)
    case 'number':
      return minimalNumber(def)
    case 'boolean':
      return false
    case 'literal':
      return def.values?.[0]
    case 'enum':
      return Object.values(def.entries ?? {})[0]
    case 'array': {
      const min = checksOf(def).find((check) => check.check === 'min_length')
      const count = typeof min?.minimum === 'number' ? min.minimum : 0
      return Array.from({ length: count }, () => minimalFor(def.element as z.ZodType, key))
    }
    case 'record':
      return {}
    case 'optional':
    case 'default':
    case 'nullable':
      return minimalFor(def.innerType as z.ZodType, key)
    case 'pipe':
      return minimalFor(def.in as z.ZodType, key)
    case 'union':
      return minimalFor((def.options as z.ZodType[])[0], key)
    default:
      throw new Error(`route-auth-matrix: unsupported zod type '${def.type}' for '${key}'`)
  }
}

// One body per op. A discriminated union yields one per option; an object
// with an op enum yields one per enum value; a plain object yields one.
function bodiesFor(schema: z.ZodType): Array<{ op: string | null; body: Record<string, unknown> }> {
  const def = defOf(schema)
  if (def.type === 'union') {
    return (def.options as z.ZodType[]).map((option) => {
      const body = minimalFor(option) as Record<string, unknown>
      return { op: String(body.op), body }
    })
  }
  if (def.type === 'object') {
    const opSchema = def.shape?.op
    if (opSchema) {
      let opDef = defOf(opSchema)
      while (opDef.innerType) opDef = defOf(opDef.innerType)
      if (opDef.type === 'enum') {
        return Object.values(opDef.entries ?? {}).map((op) => ({
          op: String(op),
          body: { ...(minimalFor(schema) as Record<string, unknown>), op },
        }))
      }
    }
    return [{ op: null, body: minimalFor(schema) as Record<string, unknown> }]
  }
  throw new Error('route-auth-matrix: unsupported top-level validator')
}

type RouteCase = {
  name: string
  schema: string
  // fields a superRefine demands beyond the declared shape
  overrides?: Record<string, Record<string, unknown>>
  // extra request headers for specific ops (server-injected idempotency keys)
  headers?: Record<string, Record<string, string>>
  // ops the route resolves before authentication is complete (none today)
  skipOps?: string[]
}

const ROUTES: RouteCase[] = [
  { name: 'auto-refill', schema: 'gtmAutoRefillBodySchema' },
  { name: 'campaigns', schema: 'gtmCampaignsBodySchema' },
  {
    name: 'candidates',
    schema: 'gtmCandidatesBodySchema',
    overrides: { export: { workspaceId: UUID, playId: UUID } },
    headers: { export: { 'idempotency-key': 'export-key-1' } },
  },
  { name: 'chat', schema: 'gtmChatBodySchema' },
  { name: 'decision-makers', schema: 'gtmDecisionMakersBodySchema' },
  {
    name: 'enrich',
    schema: 'gtmEnrichBodySchema',
    // The route requires one scope id before it resolves the user.
    overrides: { plan: { runId: UUID }, run: { runId: UUID }, status: { runId: UUID } },
  },
  { name: 'execution', schema: 'gtmExecutionBodySchema' },
  { name: 'gtm-inbox', schema: 'gtmInboxBodySchema' },
  { name: 'handoff', schema: 'gtmHandoffBodySchema' },
  { name: 'import-audience-play', schema: 'importAudiencePlayBodySchema' },
  {
    name: 'manual-outreach',
    schema: 'gtmManualOutreachBodySchema',
    headers: { create: { 'idempotency-key': 'manual-key-1' } },
  },
  { name: 'overview', schema: 'gtmOverviewBodySchema' },
  { name: 'plays', schema: 'gtmPlayDetailBodySchema' },
  { name: 'privacy', schema: 'gtmPrivacyBodySchema' },
  { name: 'reconciliation', schema: 'gtmReconciliationBodySchema' },
  { name: 'research-runs', schema: 'gtmResearchRunsBodySchema' },
  { name: 'social-connections', schema: 'gtmSocialConnectionsBodySchema' },
  { name: 'strategy', schema: 'gtmStrategyBodySchema' },
  { name: 'tasks', schema: 'gtmTasksBodySchema' },
]

async function routeHandler(name: string): Promise<(req: Request) => Promise<Response>> {
  const mod = (await import(`../../api/internal/${name}/route`)) as { POST: (req: Request) => Promise<Response> }
  return mod.POST
}

describe('internal GTM route auth matrix', () => {
  beforeEach(() => {
    resetHarness()
  })

  it('covers every internal route directory that represents a human', () => {
    const internalDir = path.resolve(__dirname, '../../api/internal')
    const dirs = readdirSync(internalDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    // removal-request is account-free and retention is process-secret-only;
    // both have their own handler-level tests.
    expect(dirs.filter((name) => !['removal-request', 'retention'].includes(name))).toEqual(
      ROUTES.map((route) => route.name).sort(),
    )
  })

  describe.each(ROUTES)('$name', (route) => {
    it('denies a missing bearer', async () => {
      const POST = await routeHandler(route.name)
      const response = await POST(internalRequest({ noliUserId: 'x' }, {}))
      expect(response.status).toBe(401)
    })

    it('denies a wrong bearer of the same byte length', async () => {
      const POST = await routeHandler(route.name)
      const wrong = `${HARNESS_SECRET.slice(0, -1)}${HARNESS_SECRET.endsWith('9') ? '8' : '9'}`
      const response = await POST(internalRequest({ noliUserId: 'x' }, bearer(wrong)))
      expect(response.status).toBe(401)
    })

    it('denies (never throws on) a multibyte bearer of the same UTF-16 length', async () => {
      const POST = await routeHandler(route.name)
      const multibyte = 'é'.repeat(HARNESS_SECRET.length)
      const response = await POST(internalRequest({ noliUserId: 'x' }, bearer(multibyte)))
      expect(response.status).toBe(401)
    })

    it('denies the account-free removal path secret when the secret is unset', async () => {
      const POST = await routeHandler(route.name)
      delete process.env.NOLI_INTERNAL_SERVICE_SECRET
      const response = await POST(internalRequest({ noliUserId: 'x' }, bearer('')))
      expect(response.status).toBe(401)
    })

    it('returns 403 for a represented user without GTM features on every op', async () => {
      const POST = await routeHandler(route.name)
      const validators = (await import('../../data/validators')) as Record<string, z.ZodType>
      const schema = validators[route.schema]
      expect(schema).toBeDefined()
      const cases = bodiesFor(schema).filter((entry) => !route.skipOps?.includes(entry.op ?? ''))
      expect(cases.length).toBeGreaterThan(0)
      for (const entry of cases) {
        const opKey = entry.op ?? ''
        const body = { ...entry.body, ...(route.overrides?.[opKey] ?? {}) }
        const headers = { ...bearer(), ...(route.headers?.[opKey] ?? {}) }
        harness.features = new Set()
        const response = await POST(internalRequest(body, headers))
        const json = await readJson(response)
        expect({ op: opKey, status: response.status, error: json.error }).toEqual({
          op: opKey,
          status: 403,
          error: 'Forbidden',
        })
      }
    })
  })
})
