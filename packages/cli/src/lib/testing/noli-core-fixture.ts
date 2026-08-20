import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export const NOLI_CORE_FIXTURE_SERVICE_KEY = 'om-ephemeral-noli-core-service-key'
export const NOLI_CORE_FIXTURE_USER_ID = '00000000-0000-4000-8000-000000000101'
export const NOLI_CORE_FIXTURE_ORG_ID = '00000000-0000-4000-8000-000000000201'
export const NOLI_CORE_FIXTURE_CLERK_USER_ID = 'user_gtm_ephemeral_admin'
export const NOLI_CORE_FIXTURE_EMAIL = 'admin@acme.com'

export type NoliCoreFixtureServer = {
  baseUrl: string
  stop: () => Promise<void>
}

function eqFilter(url: URL, name: string, expected: string): boolean {
  return url.searchParams.get(name) === `eq.${expected}`
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function fixtureRows(url: URL): Array<Record<string, unknown>> | null {
  if (url.pathname === '/rest/v1/users') {
    const matchesId = eqFilter(url, 'id', NOLI_CORE_FIXTURE_USER_ID)
    const matchesClerk = eqFilter(url, 'clerk_user_id', NOLI_CORE_FIXTURE_CLERK_USER_ID)
    if (!matchesId && !matchesClerk) return []
    return [{
      id: NOLI_CORE_FIXTURE_USER_ID,
      clerk_user_id: NOLI_CORE_FIXTURE_CLERK_USER_ID,
      email: NOLI_CORE_FIXTURE_EMAIL,
      first_name: 'GTM',
      last_name: 'Fixture',
      cohort: 'pure-saas',
    }]
  }

  if (url.pathname === '/rest/v1/entitlements') {
    if (
      eqFilter(url, 'user_id', NOLI_CORE_FIXTURE_USER_ID)
      && eqFilter(url, 'app', 'crm')
    ) {
      return [{ active: true }]
    }
    return []
  }

  if (url.pathname === '/rest/v1/organization_members') {
    if (eqFilter(url, 'user_id', NOLI_CORE_FIXTURE_USER_ID)) {
      return [{ organization_id: NOLI_CORE_FIXTURE_ORG_ID }]
    }
    return []
  }

  return null
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    json(res, 405, { message: 'fixture server is read-only' })
    return
  }
  if (req.headers.apikey !== NOLI_CORE_FIXTURE_SERVICE_KEY) {
    json(res, 401, { message: 'invalid fixture service key' })
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const rows = fixtureRows(url)
  if (rows === null) {
    json(res, 404, { message: 'unknown fixture relation' })
    return
  }
  json(res, 200, rows)
}

/**
 * Minimal, loopback-only PostgREST fixture used by the disposable integration
 * environment. It exposes only the three read paths needed to re-resolve one
 * synthetic Noli identity; there are no write/RPC/provider endpoints.
 */
export async function startNoliCoreFixtureServer(): Promise<NoliCoreFixtureServer> {
  const server = createServer(handleRequest)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Could not resolve Noli Core fixture server address')
  }

  let stopped = false
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      if (stopped) return
      stopped = true
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}
