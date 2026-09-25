/* Scout read tools: tell "the lookup failed" apart from "there is nothing".
 *
 * The assistant's read tools used to turn any failed request (500, network
 * error, bad JSON) into an empty list, so Scout would confidently answer
 * "You have no calendar events scheduled" while the events API was down.
 * These helpers return an explicit failure result instead; the tool runner
 * sends ok:false results to the model as failures, and the message tells the
 * model not to claim there is nothing. */

export type AssistantToolResult = { ok: boolean; message: string }

export function readFailure(what: string): AssistantToolResult {
  return {
    ok: false,
    message: `Could not load ${what} right now, so this could not be checked. Tell the user the check failed and to try again shortly. Do not say there are none.`,
  }
}

/** One line for Scout's context when a section could not be read. */
export function contextSectionUnavailable(label: string, what: string): string {
  return `${label}: could not be loaded right now. If the user asks about ${what}, say you could not check; do not say there are none.`
}

export type ReadListOutcome<T = any> =
  | { ok: true; items: T[]; body: any }
  | { ok: false; failure: AssistantToolResult }

/** Fetches a list endpoint ({ ok, data } or { items }) and reports failures
 *  instead of treating them as an empty list. */
export async function fetchListForAssistant<T = any>(
  url: string,
  what: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadListOutcome<T>> {
  let res: Response
  try {
    res = await fetchImpl(url, { credentials: 'include' })
  } catch {
    return { ok: false, failure: readFailure(what) }
  }
  let body: any = null
  try {
    body = await res.json()
  } catch {
    return { ok: false, failure: readFailure(what) }
  }
  if (!res.ok || !body || body.ok === false) return { ok: false, failure: readFailure(what) }
  const items = Array.isArray(body.data) ? body.data : Array.isArray(body.items) ? body.items : null
  if (!items) return { ok: false, failure: readFailure(what) }
  return { ok: true, items, body }
}

/** Fetches a non-list endpoint and reports failures. */
export async function fetchJsonForAssistant(
  url: string,
  what: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; body: any } | { ok: false; failure: AssistantToolResult }> {
  try {
    const res = await fetchImpl(url, { credentials: 'include' })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body || body.ok === false) return { ok: false, failure: readFailure(what) }
    return { ok: true, body }
  } catch {
    return { ok: false, failure: readFailure(what) }
  }
}

/** Keeps only events that have not started yet, soonest first. */
export function upcomingOnly<T extends { start_time?: string | Date | null; status?: string | null }>(rows: T[], now: Date = new Date()): T[] {
  return rows
    .filter((r) => r.start_time && new Date(r.start_time).getTime() >= now.getTime() && r.status !== 'cancelled')
    .sort((a, b) => new Date(a.start_time as any).getTime() - new Date(b.start_time as any).getTime())
}
