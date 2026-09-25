/**
 * Is this IP address off-limits for a server-side fetch of a customer-supplied
 * URL (SSRF)? Shared by the app's safeFetch and webhook delivery.
 *
 * Blocks loopback, private, link-local (cloud metadata), CGNAT, benchmarking
 * (198.18.0.0/15), documentation, multicast and reserved IPv4 ranges, and the
 * IPv6 equivalents. IPv6 forms that carry an IPv4 address inside them are
 * unwrapped and the embedded IPv4 is checked too, in any spelling:
 * IPv4-mapped (::ffff:127.0.0.1 and ::ffff:7f00:1), IPv4-compatible
 * (::127.0.0.1), NAT64 (64:ff9b::/96 and 64:ff9b:1::/48) and 6to4 (2002::/16).
 * Anything that does not parse as an IP is blocked.
 */

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

function ipv4Blocked([a, b, c]: number[]): boolean {
  if (a === 0) return true // "this network"
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0 && c === 0) return true // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

/** Expand an IPv6 literal (optionally with a trailing dotted IPv4) to 8 hextets. */
function parseIPv6(raw: string): number[] | null {
  let ip = raw.toLowerCase()
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)
  if (!ip.includes(':')) return null

  // A trailing dotted IPv4 becomes two hextets.
  const lastColon = ip.lastIndexOf(':')
  const tail = ip.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (!v4) return null
    ip = `${ip.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }

  const halves = ip.split('::')
  if (halves.length > 2) return null
  const toHextets = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      out.push(parseInt(group, 16))
    }
    return out
  }
  const head = toHextets(halves[0])
  if (!head) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const rest = toHextets(halves[1])
  if (!rest) return null
  const missing = 8 - head.length - rest.length
  if (missing < 1) return null
  return [...head, ...new Array(missing).fill(0), ...rest]
}

function embeddedIPv4(h: number[], fromHextet: number): number[] {
  return [h[fromHextet] >> 8, h[fromHextet] & 0xff, h[fromHextet + 1] >> 8, h[fromHextet + 1] & 0xff]
}

function ipv6Blocked(h: number[]): boolean {
  const allZeroUpTo = (n: number) => h.slice(0, n).every((x) => x === 0)
  // :: (unspecified) and ::1 (loopback)
  if (allZeroUpTo(7) && (h[7] === 0 || h[7] === 1)) return true
  // IPv4-mapped ::ffff:a.b.c.d (any spelling)
  if (allZeroUpTo(5) && h[5] === 0xffff) return ipv4Blocked(embeddedIPv4(h, 6))
  // IPv4-translated ::ffff:0:a.b.c.d
  if (allZeroUpTo(4) && h[4] === 0xffff && h[5] === 0) return ipv4Blocked(embeddedIPv4(h, 6))
  // IPv4-compatible ::a.b.c.d (deprecated, still routed by some stacks)
  if (allZeroUpTo(6)) return ipv4Blocked(embeddedIPv4(h, 6))
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    if (h.slice(2, 6).every((x) => x === 0)) return ipv4Blocked(embeddedIPv4(h, 6))
    if (h[2] === 1) return true
  }
  // 6to4 2002:AABB:CCDD::/48 embeds the IPv4 in hextets 1-2
  if (h[0] === 0x2002) return ipv4Blocked(embeddedIPv4(h, 1))
  // Teredo 2001:0::/32 tunnels to arbitrary IPv4 hosts
  if (h[0] === 0x2001 && h[1] === 0) return true
  // Documentation 2001:db8::/32
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true
  // Discard-only 100::/64
  if (h[0] === 0x100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true
  if ((h[0] & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return true // site-local fec0::/10 (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true // multicast ff00::/8
  return false
}

export function isBlockedIpAddress(ip: string): boolean {
  const trimmed = (ip ?? '').trim()
  const v4 = parseIPv4(trimmed)
  if (v4) return ipv4Blocked(v4)
  const v6 = parseIPv6(trimmed)
  if (v6) return ipv6Blocked(v6)
  return true
}
