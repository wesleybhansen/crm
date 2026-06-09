import dns from 'node:dns/promises'
import net from 'node:net'

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

function ipIsBlocked(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // multicast / reserved
    return false
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe80')) return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    const mapped = lower.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (mapped) return ipIsBlocked(mapped[1])
    return false
  }
  return true
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (ipIsBlocked(hostname)) throw new SsrfError(`blocked address: ${hostname}`)
    return
  }
  let resolved: Array<{ address: string }>
  try {
    resolved = await dns.lookup(hostname, { all: true })
  } catch {
    throw new SsrfError(`could not resolve host: ${hostname}`)
  }
  if (!resolved.length) throw new SsrfError(`no DNS records for host: ${hostname}`)
  for (const r of resolved) {
    if (ipIsBlocked(r.address)) throw new SsrfError(`host resolves to blocked address: ${r.address}`)
  }
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
    const res = await fetch(url, { ...init, redirect: 'manual' })
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
