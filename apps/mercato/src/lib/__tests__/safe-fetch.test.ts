import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import { assertPublicUrl, safeFetch, SsrfError } from '../safe-fetch'

describe('SSRF-safe fetch', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    'http://127.0.0.1/internal',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/private',
    'http://[::1]/internal',
  ])('rejects blocked literal address %s before a request', async (url) => {
    await expect(safeFetch(url)).rejects.toBeInstanceOf(SsrfError)
  })

  it('rejects non-HTTP protocols before resolution', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toMatchObject({
      name: 'SsrfError',
      message: 'blocked protocol: file:',
    })
  })

  it('revalidates and pins the DNS result used by the actual socket connection', async () => {
    jest.spyOn(dnsPromises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ])
    jest.spyOn(dns, 'lookup').mockImplementation(((_hostname, _options, callback) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }])
    }) as typeof dns.lookup)

    await expect(safeFetch('http://dns-rebinding.invalid/public')).rejects.toMatchObject({
      name: 'SsrfError',
      message: 'host resolves to blocked address: 127.0.0.1',
    })
    expect(dns.lookup).toHaveBeenCalledWith(
      'dns-rebinding.invalid',
      expect.objectContaining({ all: true }),
      expect.any(Function),
    )
  })

  it('rejects a hostname when any returned address is private', async () => {
    jest.spyOn(dnsPromises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ])

    await expect(assertPublicUrl('https://mixed-address.invalid')).rejects.toMatchObject({
      name: 'SsrfError',
      message: 'host resolves to blocked address: 192.168.1.10',
    })
  })
})
