/**
 * The assistant's manage_automation_advanced tool, run in the browser.
 *
 * Every mutation checks the response and reports the server's own refusal
 * (e.g. 422 email_not_connected when an email automation is switched on with
 * no sending setup). Before this, enable/disable/edit/delete sent the rule id
 * in the body, which the route ignored, and reported success regardless.
 */

export type AssistantActionResult = { ok: boolean; message: string }

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

const RULES_URL = '/api/sequences/automation-rules'

async function readBody(res: Pick<Response, 'json'>): Promise<Record<string, any>> {
  try {
    const body = await res.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

async function mutate(
  fetchImpl: FetchLike,
  method: 'PUT' | 'DELETE',
  ruleId: string,
  body: Record<string, unknown> | null,
  success: string,
  failure: string,
): Promise<AssistantActionResult> {
  try {
    const res = await fetchImpl(`${RULES_URL}?id=${encodeURIComponent(ruleId)}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await readBody(res)
    if (!res.ok || data.ok === false) {
      return { ok: false, message: typeof data.error === 'string' && data.error ? data.error : failure }
    }
    return { ok: true, message: success }
  } catch {
    return { ok: false, message: failure }
  }
}

export async function runAutomationAction(
  data: { action?: string; ruleId?: string; name?: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<AssistantActionResult> {
  const sub = data.action
  const ruleId = typeof data.ruleId === 'string' ? data.ruleId.trim() : ''
  if (!ruleId) return { ok: false, message: 'Which automation? No automation id was given.' }

  switch (sub) {
    case 'enable':
      return mutate(fetchImpl, 'PUT', ruleId, { isActive: true }, 'Automation enabled', 'Could not enable the automation')
    case 'disable':
      return mutate(fetchImpl, 'PUT', ruleId, { isActive: false }, 'Automation disabled', 'Could not disable the automation')
    case 'edit': {
      const name = typeof data.name === 'string' ? data.name.trim() : ''
      if (!name) return { ok: false, message: 'Nothing to change: give the automation a new name.' }
      return mutate(fetchImpl, 'PUT', ruleId, { name }, 'Automation updated', 'Could not update the automation')
    }
    case 'delete':
      return mutate(fetchImpl, 'DELETE', ruleId, null, 'Automation deleted', 'Could not delete the automation')
    case 'test': {
      try {
        const res = await fetchImpl(`${RULES_URL}/test`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ ruleId }),
        })
        const d = await readBody(res)
        return res.ok && d.ok ? { ok: true, message: 'Automation test executed' } : { ok: false, message: d.error || 'Test failed' }
      } catch {
        return { ok: false, message: 'Test failed' }
      }
    }
    case 'get_logs': {
      try {
        const res = await fetchImpl(`${RULES_URL}/${encodeURIComponent(ruleId)}/logs`, { credentials: 'include' })
        const d = await readBody(res)
        return d.ok ? { ok: true, message: `${d.data?.length || 0} execution(s) logged` } : { ok: false, message: d.error || 'Could not load the logs' }
      } catch {
        return { ok: false, message: 'Could not load the logs' }
      }
    }
    default:
      return { ok: false, message: `Unknown automation action: ${sub}` }
  }
}
