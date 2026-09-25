import { secretEquals } from '../secretEquals'
import { signJwt, verifyJwt } from '../jwt'

describe('secretEquals', () => {
  it('matches equal secrets only', () => {
    expect(secretEquals('abc', 'abc')).toBe(true)
    expect(secretEquals('abc', 'abd')).toBe(false)
    expect(secretEquals('abc', 'abcd')).toBe(false)
  })

  it('never throws on lengths or encodings that differ', () => {
    // Same UTF-16 length, different byte length: a raw timingSafeEqual throws here.
    expect(() => secretEquals('é'.repeat(4), 'eeee')).not.toThrow()
    expect(secretEquals('é'.repeat(4), 'eeee')).toBe(false)
  })

  it('never matches missing or empty values', () => {
    expect(secretEquals('', '')).toBe(false)
    expect(secretEquals(undefined, 'x')).toBe(false)
    expect(secretEquals('x', null)).toBe(false)
  })
})

describe('verifyJwt signature check', () => {
  it('rejects a signature of the wrong length without throwing', () => {
    const token = signJwt({ sub: 'u' }, 'secret')
    const [h, p] = token.split('.')
    expect(() => verifyJwt(`${h}.${p}.short`, 'secret')).not.toThrow()
    expect(verifyJwt(`${h}.${p}.short`, 'secret')).toBeNull()
    expect(verifyJwt(token, 'secret')).toMatchObject({ sub: 'u' })
  })
})
