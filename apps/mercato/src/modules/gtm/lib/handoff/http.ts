/*
 * Shared HTTP plumbing for the Tranche 7 cross-app handoff clients
 * (lib/handoff/ams-assets.ts, lib/handoff/kb-mirror.ts).
 *
 * Both clients take an INJECTABLE fetch: production uses globalThis.fetch,
 * tests always inject a fake. Nothing in this module (or the clients) opens
 * a socket on import, and no test may ever perform a real call.
 */

// Minimal structural slice of fetch, so tests inject a plain function.
export type FetchLikeResponse = {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<FetchLikeResponse>

export type GtmHandoffErrorCode =
  | 'handoff_unconfigured'
  | 'request_failed'
  | 'bad_response'

export class GtmHandoffError extends Error {
  constructor(
    public code: GtmHandoffErrorCode,
    message: string,
    public status?: number,
  ) {
    super(message)
    this.name = 'GtmHandoffError'
  }
}

export function defaultFetch(): FetchLike {
  return (url, init) => (globalThis.fetch as unknown as FetchLike)(url, init)
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export async function requestJson(
  fetchImpl: FetchLike,
  target: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  label: string,
): Promise<unknown> {
  let response: FetchLikeResponse
  try {
    response = await fetchImpl(target, init)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new GtmHandoffError('request_failed', `${label} transport error: ${message}`)
  }
  if (!response.ok) {
    throw new GtmHandoffError(
      'request_failed',
      `${label} failed with status ${response.status}`,
      response.status,
    )
  }
  try {
    return await response.json()
  } catch {
    throw new GtmHandoffError('bad_response', `${label} returned an unparseable body`)
  }
}

// provision-key responses come in two shapes across the Noli apps:
// { key } or { data: { key } }. Anything else is a bad response.
export function parseProvisionedKey(data: unknown, label: string): string {
  const root = (data ?? {}) as Record<string, unknown>
  const nested = (root.data ?? {}) as Record<string, unknown>
  const key = typeof root.key === 'string' ? root.key : nested.key
  if (typeof key !== 'string' || key.length === 0) {
    throw new GtmHandoffError('bad_response', `${label} response carried no key`)
  }
  return key
}

export function internalServiceSecret(): string | null {
  const secret = (process.env.NOLI_INTERNAL_SERVICE_SECRET ?? '').trim()
  return secret.length > 0 ? secret : null
}
