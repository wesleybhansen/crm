import type { Knex } from 'knex'

/* Commitments: first-class "what was promised, both directions" records.
 *
 * Table `commitments` (scripts/sql/crm-batch-2026-07-10.sql). Rows come from
 * three sources: AI extraction over a contact's recent emails (lazy, at
 * meeting-prep time so cost is bounded to contacts you're about to meet),
 * voice debriefs, and manual/Scout adds. Meeting prep surfaces open ones.
 * The extractor NEVER meters itself — callers gate + meter (house rule from
 * ai-summaries.ts). */

const EXTRACT_MODEL = 'gemini-2.5-flash'
const MAX_EMAILS = 12
const PER_MESSAGE_CAP = 1200

export type Commitment = {
  id: string
  direction: 'ours' | 'theirs'
  description: string
  due_at: string | null
  status: string
  source: string
  created_at: string
}

export async function listOpenCommitments(
  knex: Knex,
  orgId: string,
  contactId: string,
  limit = 10,
): Promise<Commitment[]> {
  try {
    return await knex('commitments')
      .where('organization_id', orgId)
      .where('contact_id', contactId)
      .where('status', 'open')
      .orderByRaw('due_at nulls last, created_at desc')
      .limit(limit)
      .select('id', 'direction', 'description', 'due_at', 'status', 'source', 'created_at')
  } catch {
    return [] // table missing (migration not applied) — degrade gracefully
  }
}

function normalizeDesc(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** Extract commitments from the contact's recent email exchange and insert
 * any NEW open ones (deduped against everything already stored for the
 * contact). Returns token usage so the caller can meter. */
export async function extractCommitmentsForContact(
  knex: Knex,
  apiKey: string,
  orgId: string,
  tenantId: string | null,
  contactId: string,
): Promise<{ created: number; tokensIn: number; tokensOut: number; model: string }> {
  const none = { created: 0, tokensIn: 0, tokensOut: 0, model: EXTRACT_MODEL }
  try {
    const emails = await knex('email_messages')
      .where('organization_id', orgId)
      .where('contact_id', contactId)
      .orderBy('created_at', 'desc')
      .limit(MAX_EMAILS)
      .select('direction', 'body_text', 'body_html', 'subject', 'created_at')
    if (emails.length === 0) return none

    // Only re-extract when there's mail newer than the last extraction run.
    const latest = await knex('commitments')
      .where('organization_id', orgId)
      .where('contact_id', contactId)
      .where('source', 'email')
      .max('created_at as at')
      .first()
    const newestMail = emails[0]?.created_at ? new Date(emails[0].created_at) : null
    if (latest?.at && newestMail && new Date(latest.at) >= newestMail) return none

    const transcript = emails
      .reverse()
      .map((m: any) => {
        const body = (m.body_text || (m.body_html || '').replace(/<[^>]+>/g, ' ')).toString()
        return `[${m.direction === 'inbound' ? 'THEM' : 'US'} · ${new Date(m.created_at).toISOString().slice(0, 10)}] ${m.subject ?? ''}\n${body.slice(0, PER_MESSAGE_CAP)}`
      })
      .join('\n---\n')

    const prompt = `Extract the CONCRETE COMMITMENTS from this email exchange between a business (US) and a contact (THEM). A commitment is a specific promised action: "we'll send the proposal by Friday", "I'll review and get back to you next week". Ignore vague pleasantries and anything already visibly completed later in the thread.

Return ONLY a JSON array (no markdown fences), max 6 items:
[{"direction": "ours" | "theirs", "description": "<one sentence, plain language, who promised what>", "dueDate": "YYYY-MM-DD" | null}]
Return [] if there are none.

Exchange:
${transcript}`

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACT_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 700, temperature: 0.2 },
        }),
      },
    )
    const aiData = await aiRes.json()
    const tokensIn = aiData?.usageMetadata?.promptTokenCount || 0
    const tokensOut = aiData?.usageMetadata?.candidatesTokenCount || 0
    const text: string | undefined = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!text) return { ...none, tokensIn, tokensOut }

    let items: Array<{ direction?: string; description?: string; dueDate?: string | null }> = []
    try {
      const match = text.match(/\[[\s\S]*\]/)
      items = match ? JSON.parse(match[0]) : []
    } catch {
      return { ...none, tokensIn, tokensOut }
    }

    const existing = await knex('commitments')
      .where('organization_id', orgId)
      .where('contact_id', contactId)
      .select('description')
    const seen = new Set(existing.map((r: any) => normalizeDesc(r.description)))

    let created = 0
    for (const item of items.slice(0, 6)) {
      const description = (item.description ?? '').trim()
      if (description.length < 10 || description.length > 500) continue
      const direction = item.direction === 'theirs' ? 'theirs' : 'ours'
      const key = normalizeDesc(description)
      if (seen.has(key)) continue
      seen.add(key)
      const dueAt = item.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) ? new Date(item.dueDate) : null
      await knex('commitments').insert({
        organization_id: orgId,
        tenant_id: tenantId,
        contact_id: contactId,
        direction,
        description,
        due_at: dueAt,
        status: 'open',
        source: 'email',
      })
      created++
    }
    return { created, tokensIn, tokensOut, model: EXTRACT_MODEL }
  } catch {
    return none
  }
}

export function formatCommitmentsForBrief(commitments: Commitment[]): string {
  if (commitments.length === 0) return ''
  const lines = commitments.map((c) => {
    const who = c.direction === 'ours' ? 'WE promised' : 'THEY promised'
    const due = c.due_at ? ` (due ${new Date(c.due_at).toISOString().slice(0, 10)})` : ''
    return `- ${who}: ${c.description}${due}`
  })
  return `\nOPEN COMMITMENTS (address these — nothing builds trust like keeping promises, and nothing burns it like forgetting them):\n${lines.join('\n')}\n`
}
