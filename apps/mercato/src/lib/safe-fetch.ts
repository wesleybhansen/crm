import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import net from 'node:net'
import { Agent } from 'undici'
import { isBlockedIpAddress } from '@open-mercato/shared/lib/network/blocked-ip'

/* SSRF-safe fetch. Routes that fetch a USER-SUPPLIED URL (website scanners)
 * must use this instead of a raw fetch, or an authenticated customer can point
 * the URL at the box's internal services — the cloud metadata endpoint
 * (169.254.169.254), localhost, or RFC-1918 hosts — and read the response.
 * Resolves the host and rejects private/loopback/link-local/reserved addresses
 * before connecting, re-validating each redirect hop. Only http(s) is allowed. */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

// Shared classifier: also unwraps hex IPv4-mapped (::ffff:7f00:1), NAT64
// (64:ff9b::/96), 6to4 and IPv4-compatible forms, and blocks 198.18.0.0/15
// and the documentation ranges (security sweep 2026-09-25, low).
function ipIsBlocked(ip: string): boolean {
  return isBlockedIpAddress(ip)
}

function blockedLookupError(message: string): NodeJS.ErrnoException {
  const error = new SsrfError(message) as NodeJS.ErrnoException
  error.code = 'EACCES'
  return error
}

function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  const { all: _all, ...lookupOptions } = options
  dns.lookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
    if (error) {
      callback(blockedLookupError(`could not resolve host: ${hostname}`), '0.0.0.0', 4)
      return
    }
    if (addresses.length === 0) {
      callback(blockedLookupError(`no DNS records for host: ${hostname}`), '0.0.0.0', 4)
      return
    }
    const blocked = addresses.find((row) => ipIsBlocked(row.address))
    if (blocked) {
      callback(blockedLookupError(`host resolves to blocked address: ${blocked.address}`), '0.0.0.0', 4)
      return
    }
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  })
}

// Node's global fetch is powered by undici and accepts a dispatcher even
// though the web-standard RequestInit type does not expose it. The dispatcher's
// lookup is the lookup used by the actual TCP/TLS connection. Validating here,
// rather than only in a preflight DNS query, closes the resolve/connect gap in
// which a rebinding hostname could resolve publicly during validation and to a
// private address when the socket is opened.
const safeDispatcher = new Agent({ connect: { lookup: safeLookup } })

async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (ipIsBlocked(hostname)) throw new SsrfError(`blocked address: ${hostname}`)
    return
  }
  let resolved: Array<{ address: string }>
  try {
    resolved = await dnsPromises.lookup(hostname, { all: true })
  } catch {
    throw new SsrfError(`could not resolve host: ${hostname}`)
  }
  if (!resolved.length) throw new SsrfError(`no DNS records for host: ${hostname}`)
  for (const r of resolved) {
    if (ipIsBlocked(r.address)) throw new SsrfError(`host resolves to blocked address: ${r.address}`)
  }
}

/* Validate a user-supplied URL is http(s) and resolves to a public address.
 * Use when a target URL is SAVED (e.g. a webhook subscription) so an SSRF target
 * (localhost / 169.254.169.254 / RFC-1918) can never be stored. Delivery-time
 * fetch should still be guarded to fully close DNS-rebinding. */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new SsrfError('invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`blocked protocol: ${url.protocol}`)
  }
  await assertPublicHost(url.hostname)
}

export async function safeFetch(rawUrl: string, init?: RequestInit, maxRedirects = 5): Promise<Response> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new SsrfError('invalid URL')
  }
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SsrfError(`blocked protocol: ${url.protocol}`)
    }
    await assertPublicHost(url.hostname)
    let res: Response
    try {
      res = await fetch(url, {
        ...init,
        redirect: 'manual',
        // Runtime-supported undici extension. `satisfies` is unavailable here
        // because the DOM RequestInit declaration intentionally omits it.
        dispatcher: safeDispatcher,
      } as RequestInit & { dispatcher: Agent })
    } catch (error) {
      const pending: unknown[] = [error]
      const inspected = new Set<unknown>()
      while (pending.length > 0) {
        const current = pending.shift()
        if (current == null || inspected.has(current)) continue
        inspected.add(current)
        if (current instanceof SsrfError) throw current
        if (typeof current !== 'object') continue
        const wrapped = current as {
          name?: unknown
          message?: unknown
          code?: unknown
          cause?: unknown
          errors?: unknown
        }
        if (
          (
            wrapped.name === 'SsrfError'
            || wrapped.code === 'EACCES'
            || (
              typeof wrapped.message === 'string'
              && wrapped.message.startsWith('SsrfError: ')
            )
          )
          && typeof wrapped.message === 'string'
        ) {
          throw new SsrfError(wrapped.message.replace(/^SsrfError:\s*/, ''))
        }
        if (wrapped.cause != null) pending.push(wrapped.cause)
        if (Array.isArray(wrapped.errors)) pending.push(...wrapped.errors)
      }
      throw error
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res
      try {
        url = new URL(location, url)
      } catch {
        throw new SsrfError('invalid redirect target')
      }
      continue
    }
    return res
  }
  throw new SsrfError('too many redirects')
}
