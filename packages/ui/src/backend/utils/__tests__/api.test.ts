/**
 * @jest-environment jsdom
 */
jest.mock('../../FlashMessages', () => ({
  flash: jest.fn(),
}))

import { flash } from '../../FlashMessages'
import {
  ForbiddenError,
  UnauthorizedError,
  apiFetch,
  isReplayableRequest,
} from '../../utils/api'

function createMockResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  const serializedBody =
    typeof body === 'string' ? body : JSON.stringify(body ?? {})
  const headerMap = new Map<string, string>(
    Object.entries(headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  )
  const build = () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (key: string) => headerMap.get(key.toLowerCase()) ?? null,
      },
      json: async () => JSON.parse(serializedBody),
      text: async () => serializedBody,
      clone: () => build(),
    }) as Response
  return build()
}

describe('apiFetch', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.useFakeTimers()
    window.history.pushState({}, '', '/backend/sales/documents')
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = undefined
  })

  afterEach(() => {
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = undefined
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('throws ForbiddenError when backend returns ACL hints', async () => {
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () =>
      createMockResponse(403, {
        error: 'Forbidden',
        requiredRoles: ['Admin'],
      }),
    )

    await expect(apiFetch('/api/private')).rejects.toBeInstanceOf(ForbiddenError)
    expect(flash).toHaveBeenCalledWith(
      "You don't have permission to do that. Ask your workspace admin for access.",
      'warning',
    )
  })

  it('throws ForbiddenError when ACL hints are missing', async () => {
    const response = createMockResponse(403, {
      error: 'Forbidden',
      message: 'Access denied without ACL hints',
    })
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () => response)

    await expect(apiFetch('/api/private')).rejects.toBeInstanceOf(ForbiddenError)
    expect(flash).not.toHaveBeenCalled()
  })

  it('does not redirect on login page and returns 403 payload', async () => {
    window.history.pushState({}, '', '/login')
    const response = createMockResponse(403, {
      error: 'Forbidden',
      requiredRoles: ['Admin'],
    })
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = jest.fn(async () => response)

    const result = await apiFetch('/api/private')
    expect(result).toBe(response)
    expect(flash).not.toHaveBeenCalled()
  })

  it('retries a read through a server blip and tells the user it is reconnecting', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(createMockResponse(503, { error: 'unavailable', retryable: true }))
      .mockResolvedValueOnce(createMockResponse(200, { ok: true }))
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = fetchMock

    const pending = apiFetch('/api/customers/people')
    await jest.advanceTimersByTimeAsync(2000)
    const result = await pending
    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(flash).toHaveBeenCalledWith('Having trouble reaching the server. Reconnecting…', 'warning')
  })

  it('never replays a write after a server error', async () => {
    const fetchMock = jest.fn().mockResolvedValue(createMockResponse(503, { error: 'unavailable' }))
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = fetchMock

    const result = await apiFetch('/api/customers/people', { method: 'POST', body: '{}' })
    expect(result.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('checks a 401 once more before treating it as a sign-out', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(createMockResponse(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(createMockResponse(200, { ok: true }))
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = fetchMock

    const pending = apiFetch('/api/customers/people')
    await jest.advanceTimersByTimeAsync(1500)
    const result = await pending
    expect(result.status).toBe(200)
    expect(flash).not.toHaveBeenCalled()
  })

  it('sends a real sign-out through the session refresh route', async () => {
    const fetchMock = jest.fn().mockResolvedValue(createMockResponse(401, { error: 'Unauthorized' }))
    ;(window as unknown as Record<string, unknown>).__omOriginalFetch = fetchMock

    const pending = apiFetch('/api/customers/people')
    const assertion = expect(pending).rejects.toBeInstanceOf(UnauthorizedError)
    await jest.advanceTimersByTimeAsync(1500)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(flash).toHaveBeenCalledWith('Session expired. Redirecting to sign in…', 'warning')
  })

  it('knows which request bodies can be sent twice', () => {
    expect(isReplayableRequest('/api/x')).toBe(true)
    expect(isReplayableRequest('/api/x', { method: 'POST', body: '{}' })).toBe(true)
    expect(isReplayableRequest('/api/x', { method: 'POST', body: new FormData() })).toBe(true)
    const streamLike = { getReader: () => null }
    expect(isReplayableRequest('/api/x', { method: 'POST', body: streamLike as unknown as BodyInit })).toBe(false)
  })
})
