import { query, queryOne } from '@/lib/db'

/*
 * Revision memory for the landing-page generator. Every piece of feedback the
 * user gives (section refinements, full-page revisions) is persisted on
 * config.revisionHistory and injected into subsequent AI calls — so a later
 * "add a guarantee" can never silently undo an earlier "make it more urgent".
 * Stored on the page's JSONB config (no migration needed).
 */

export interface RevisionEntry {
  at: string // ISO timestamp
  scope: 'page' | string // 'page' for full-page revisions, else the section type
  instruction: string
}

export interface PageWithHistory {
  page: Record<string, any>
  config: Record<string, any>
  history: RevisionEntry[]
}

export async function loadPageWithHistory(pageId: string, orgId: string): Promise<PageWithHistory | null> {
  const page = await queryOne(
    'SELECT * FROM landing_pages WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
    [pageId, orgId],
  )
  if (!page) return null
  const config = typeof page.config === 'string' ? JSON.parse(page.config) : (page.config || {})
  const history: RevisionEntry[] = Array.isArray(config.revisionHistory) ? config.revisionHistory : []
  return { page, config, history }
}

/* The prompt block: what the user has already asked for, newest last. Capped
 * so long-lived pages don't bloat the prompt. */
export function historyPromptBlock(history: RevisionEntry[]): string {
  if (history.length === 0) return ''
  const recent = history.slice(-12)
  const lines = recent.map((h) => `- [${h.scope === 'page' ? 'whole page' : h.scope}] ${h.instruction}`)
  return `
## Revision history (IMPORTANT)

The user has already requested these changes in earlier rounds, in order. They are part of the page's current state ON PURPOSE — do not undo, contradict, or water them down unless the new instruction explicitly says to:
${lines.join('\n')}
`
}

export async function appendRevision(
  pageId: string,
  orgId: string,
  config: Record<string, any>,
  entry: RevisionEntry,
): Promise<void> {
  const history: RevisionEntry[] = Array.isArray(config.revisionHistory) ? config.revisionHistory : []
  const next = [...history, entry].slice(-50)
  const updated = { ...config, revisionHistory: next }
  await query('UPDATE landing_pages SET config = $1, updated_at = $2 WHERE id = $3 AND organization_id = $4', [
    JSON.stringify(updated),
    new Date().toISOString(),
    pageId,
    orgId,
  ])
}
