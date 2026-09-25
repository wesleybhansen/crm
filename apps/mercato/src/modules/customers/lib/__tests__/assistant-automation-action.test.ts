/** @jest-environment node */
import { runAutomationAction } from '../assistant-automation-action'

function fakeFetch(status: number, body: unknown) {
  return jest.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
}

describe('assistant automation actions report what really happened', () => {
  it('enable sends the id in the query and isActive in the body', async () => {
    const f = fakeFetch(200, { ok: true, data: { id: 'r-1', is_active: true } })
    const res = await runAutomationAction({ action: 'enable', ruleId: 'r-1' }, f)
    expect(res).toEqual({ ok: true, message: 'Automation enabled' })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('/api/sequences/automation-rules?id=r-1')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({ isActive: true })
  })

  it('enable blocked by the email gate reports the refusal, not success', async () => {
    const error = 'Connect an email account in Settings before turning on this automation; nothing will be sent until then. You can save it as paused meanwhile.'
    const f = fakeFetch(422, { ok: false, code: 'email_not_connected', error })
    expect(await runAutomationAction({ action: 'enable', ruleId: 'r-1' }, f)).toEqual({ ok: false, message: error })
  })

  it('disable reports a 404 honestly', async () => {
    const f = fakeFetch(404, { ok: false, error: 'Automation not found' })
    expect(await runAutomationAction({ action: 'disable', ruleId: 'nope' }, f)).toEqual({ ok: false, message: 'Automation not found' })
  })

  it('a network failure is a failure', async () => {
    const f = jest.fn(async () => { throw new Error('offline') })
    expect((await runAutomationAction({ action: 'disable', ruleId: 'r-1' }, f)).ok).toBe(false)
  })

  it('delete uses the query id', async () => {
    const f = fakeFetch(200, { ok: true })
    expect((await runAutomationAction({ action: 'delete', ruleId: 'r 1' }, f)).ok).toBe(true)
    expect(f.mock.calls[0][0]).toBe('/api/sequences/automation-rules?id=r%201')
    expect(f.mock.calls[0][1]?.method).toBe('DELETE')
  })

  it('refuses without a rule id and without a new name for edit', async () => {
    const f = fakeFetch(200, { ok: true })
    expect((await runAutomationAction({ action: 'enable' }, f)).ok).toBe(false)
    expect((await runAutomationAction({ action: 'edit', ruleId: 'r-1' }, f)).ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })
})
