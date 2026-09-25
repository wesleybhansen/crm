/**
 * The task API validates camelCase (isDone, dueDate, contactId, ...), and zod
 * silently drops keys it does not know. Several callers (the Contacts Tasks
 * tab, Scout, dashboard widgets) send snake_case (`is_done`, `due_date`), so a
 * tick was accepted with 200 and never saved: the task came back open after a
 * reload (QA 2026-09-25 #7). Map the snake_case spellings onto the camelCase
 * ones before validation; an explicit camelCase key wins.
 *
 * Package imports only: reachable from worker bundles.
 */
const TASK_KEY_ALIASES: Record<string, string> = {
  is_done: 'isDone',
  due_date: 'dueDate',
  contact_id: 'contactId',
  deal_id: 'dealId',
  completed_at: 'completedAt',
}

export function normalizeTaskPayload<T extends Record<string, unknown>>(raw: T | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(raw ?? {}) }
  for (const [snake, camel] of Object.entries(TASK_KEY_ALIASES)) {
    if (!(snake in out)) continue
    if (!(camel in out)) out[camel] = out[snake]
    delete out[snake]
  }
  return out
}
