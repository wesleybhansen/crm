/**
 * Backwards-compatibility helpers for tier 0 mercato routes.
 *
 * The 5 CRUD-factory routes (tasks, notes, contact-attachments, reminders,
 * task-templates) need to return the OLD raw-route response shape so the
 * existing frontend code (which reads `d.data` and checks `d.ok`) keeps
 * working without 53 call site updates.
 *
 * Old raw shape:
 *   GET    → { ok: true, data: [...] }
 *   POST   → { ok: true, data: {...} } or { ok: true, id }
 *   PUT    → { ok: true, data: {...} } or { ok: true }
 *   DELETE → { ok: true }
 *   Error  → { ok: false, error: '...' }
 *
 * Mercato CRUD-factory shape:
 *   GET    → { items: [...], total, page, pageSize, totalPages }
 *   POST   → whatever response() returns, e.g. { id }
 *   PUT    → whatever response() returns, e.g. { ok: true }
 *   DELETE → whatever response() returns, e.g. { ok: true }
 *
 * These helpers wrap the mercato response in the old shape so the frontend
 * doesn't have to change. The mercato shape is still available to consumers
 * that ask for it via the OpenAPI route — Scout has its own dedicated AI
 * tools so it doesn't go through the API, and other future consumers will
 * either be migrated as part of their own tier or use the OpenAPI directly.
 *
 * SPEC-061 §"Tier 0 cutover" deferred this concern; this file is the
 * resolution. Once all the tier 0 frontend pages have been migrated to
 * consume the canonical mercato shape, this file can be deleted.
 */

import { NextResponse } from 'next/server'

/**
 * Wrap a mercato CRUD-factory GET handler so it returns the old raw shape.
 *
 *   GET /api/customers/tasks
 *     → { ok: true, data: [...], total, page, pageSize, totalPages }
 *
 * Use this in route files like:
 *
 *   const baseGet = crud.GET
 *   export const GET = wrapCrudListForLegacyShape(baseGet)
 */
export function wrapCrudListForLegacyShape(
  baseHandler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const res = await baseHandler(request)
    if (!res.ok) return res
    let body: any = null
    try {
      body = await res.json()
    } catch {
      return res
    }
    if (!body || typeof body !== 'object') return res
    // Already in legacy shape (custom routes pass through unchanged)
    if ('data' in body && !('items' in body)) return NextResponse.json(body, { status: res.status })
    const items = Array.isArray(body.items) ? body.items : []
    return NextResponse.json(
      {
        ok: true,
        data: items,
        total: body.total ?? items.length,
        page: body.page ?? 1,
        pageSize: body.pageSize ?? items.length,
        totalPages: body.totalPages ?? 1,
      },
      { status: res.status },
    )
  }
}

/**
 * Wrap a CRUD-factory POST/PUT/DELETE response object with `ok: true`.
 *
 * Use in the `response` callback of an action config:
 *
 *   create: {
 *     commandId: 'customers.tasks.create',
 *     response: ({ result }) => withLegacyOk({ id: result?.taskId ?? null }),
 *   }
 */
export function withLegacyOk<T extends Record<string, unknown>>(payload: T): { ok: true } & T {
  return { ok: true, ...payload }
}
