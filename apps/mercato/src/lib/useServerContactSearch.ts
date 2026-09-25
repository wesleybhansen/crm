'use client'

import { useEffect, useState } from 'react'

/**
 * Contact pickers: search the whole organization on the server instead of
 * filtering the first 100-1,000 contacts a page happened to load.
 *
 * Names and emails are encrypted at rest; the server matches them on the
 * blind search index (word prefixes, full / partial email, phone digits) and
 * returns decrypted rows for display. Below `minLength` characters this
 * returns null and the picker keeps showing its preloaded list.
 */
export type PickerContact = { id: string; display_name: string; primary_email: string | null }

type Options = {
  /** 'people' = /api/customers/people (contacts view), 'email' = /api/email/contacts (email lists view). */
  endpoint?: 'people' | 'email'
  minLength?: number
  limit?: number
  debounceMs?: number
}

function readItems(body: any): any[] {
  if (Array.isArray(body?.data?.items)) return body.data.items
  if (Array.isArray(body?.data)) return body.data
  if (Array.isArray(body?.items)) return body.items
  return []
}

export function useServerContactSearch(query: string, opts: Options = {}): { results: PickerContact[] | null; loading: boolean } {
  const { endpoint = 'people', minLength = 2, limit = 50, debounceMs = 250 } = opts
  const [results, setResults] = useState<PickerContact[] | null>(null)
  const [loading, setLoading] = useState(false)
  const q = query.trim()

  useEffect(() => {
    if (q.length < minLength) {
      setResults(null)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      const url = endpoint === 'email'
        ? `/api/email/contacts?search=${encodeURIComponent(q)}&limit=${limit}`
        : `/api/customers/people?search=${encodeURIComponent(q)}&pageSize=${limit}`
      fetch(url, { credentials: 'include', signal: controller.signal })
        .then((r) => r.json())
        .then((body) => {
          setResults(readItems(body).map((c: any) => ({
            id: String(c.id),
            display_name: c.display_name || c.displayName || c.name || '',
            primary_email: c.primary_email || c.primaryEmail || c.email || null,
          })))
        })
        .catch((err) => { if ((err as Error)?.name !== 'AbortError') setResults([]) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, debounceMs)
    return () => { clearTimeout(timer); controller.abort() }
  }, [q, endpoint, minLength, limit, debounceMs])

  return { results, loading }
}

/** The list a picker shows: server matches for a real query, else its own list filtered locally. */
export function pickerContacts<T extends { display_name?: string | null; primary_email?: string | null }>(
  local: T[],
  query: string,
  remote: Array<T | PickerContact> | null,
): Array<T | PickerContact> {
  if (remote) return remote
  const q = query.trim().toLowerCase()
  if (!q) return local
  return local.filter((c) => (c.display_name || '').toLowerCase().includes(q) || (c.primary_email || '').toLowerCase().includes(q))
}
