/**
 * Backwards-compatibility helpers for tier 1 mercato routes (email module).
 *
 * Same pattern as packages/core/src/modules/customers/api/legacyShape.ts
 * (the canonical tier 0 example). Copy-pasted into the email module rather
 * than imported across packages to keep modules self-contained per
 * mercato conventions.
 *
 * The new mercato CRUD-factory routes return the canonical mercato shape
 * `{ items, total, page, pageSize, totalPages }`. The existing CRM frontend
 * reads `d.data` and checks `d.ok`, so without these wrappers the frontend
 * cutover would require ~50 data extraction rewrites in addition to URL
 * updates. With these wrappers, the frontend cutover becomes pure URL
 * substitution.
 *
 * Once all the tier 1 frontend pages have been migrated to consume the
 * canonical mercato shape (a future cleanup), this file can be deleted.
 */

import { NextResponse } from 'next/server'

/**
 * Wrap a mercato CRUD-factory GET handler so it returns the old raw shape.
 *
 *   GET /api/email/lists
 *     → { ok: true, data: [...], total, page, pageSize, totalPages }
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
 *     commandId: 'email.lists.create',
 *     response: ({ result }) => withLegacyOk({ id: result?.listId ?? null }),
 *   }
 */
export function withLegacyOk<T extends Record<string, unknown>>(payload: T): { ok: true } & T {
  return { ok: true, ...payload }
}
