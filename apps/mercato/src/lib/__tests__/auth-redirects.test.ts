import { sameOriginPath } from '../auth-redirects'

describe('sameOriginPath', () => {
  it('keeps same-origin paths with their query', () => {
    expect(sameOriginPath('/backend/contacts?tab=tasks')).toBe('/backend/contacts?tab=tasks')
  })

  it('falls back to the dashboard for missing or off-site values', () => {
    expect(sameOriginPath(null)).toBe('/backend')
    expect(sameOriginPath('')).toBe('/backend')
    expect(sameOriginPath('https://evil.example/x')).toBe('/backend')
    expect(sameOriginPath('//evil.example/x')).toBe('/backend')
    expect(sameOriginPath('/\\evil.example')).toBe('/backend')
  })

  it('never sends people back to the legacy login page', () => {
    expect(sameOriginPath('/login')).toBe('/backend')
    expect(sameOriginPath('/login?redirect=%2Fbackend')).toBe('/backend')
  })
})
