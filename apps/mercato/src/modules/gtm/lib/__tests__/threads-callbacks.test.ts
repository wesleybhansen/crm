import crypto from 'node:crypto'
import {
  isThreadsDeletionConfirmationCode,
  parseThreadsSignedRequest,
  threadsDeletionConfirmationCode,
} from '../social/threads-callbacks'

const SECRET = 'synthetic-app-secret'

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const encoded = b64url(JSON.stringify(payload))
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest()
  return `${b64url(signature)}.${encoded}`
}

describe('Meta Threads signed_request callbacks', () => {
  it('accepts a request signed under the app secret and returns the Threads user id', () => {
    const parsed = parseThreadsSignedRequest(sign({ user_id: '99001', algorithm: 'HMAC-SHA256', issued_at: 1_756_900_000 }), SECRET)
    expect(parsed).toEqual({ userId: '99001', issuedAt: 1_756_900_000, algorithm: 'HMAC-SHA256' })
    expect(parseThreadsSignedRequest(sign({ user_id: 99001, algorithm: 'hmac-sha256' }), SECRET)?.userId).toBe('99001')
  })

  it('rejects a bad signature, a wrong secret, a wrong algorithm, or a malformed user id', () => {
    const good = sign({ user_id: '99001', algorithm: 'HMAC-SHA256' })
    expect(parseThreadsSignedRequest(good, 'other-secret')).toBeNull()
    expect(parseThreadsSignedRequest(`${good}x`, SECRET)).toBeNull()
    expect(parseThreadsSignedRequest(good.replace(/^./, 'A'), SECRET)).toBeNull()
    expect(parseThreadsSignedRequest(sign({ user_id: '99001', algorithm: 'HMAC-SHA1' }), SECRET)).toBeNull()
    expect(parseThreadsSignedRequest(sign({ user_id: 'abc', algorithm: 'HMAC-SHA256' }), SECRET)).toBeNull()
    expect(parseThreadsSignedRequest(sign({ algorithm: 'HMAC-SHA256' }), SECRET)).toBeNull()
    expect(parseThreadsSignedRequest('nodot', SECRET)).toBeNull()
    expect(parseThreadsSignedRequest(good, '')).toBeNull()
    expect(parseThreadsSignedRequest(42, SECRET)).toBeNull()
  })

  it('derives a stable, opaque confirmation code', () => {
    const at = new Date('2026-09-03T12:00:00.000Z')
    const code = threadsDeletionConfirmationCode('99001', at)
    expect(code).toBe(threadsDeletionConfirmationCode('99001', at))
    expect(code).not.toContain('99001')
    expect(isThreadsDeletionConfirmationCode(code)).toBe(true)
    expect(isThreadsDeletionConfirmationCode('not-a-code')).toBe(false)
    expect(threadsDeletionConfirmationCode('99002', at)).not.toBe(code)
  })
})
