/* Audiences — user-defined groups of people ("My team", "Customers", …) that the
 * inbox drafters use to decide handling by WHO the sender is (identity), not just
 * what they wrote (content flag scenarios). An audience matches a sender when the
 * sender's email (or domain), the sender's CRM contact stage, or the sender's
 * membership in a linked CRM list qualifies. Each audience carries an action the
 * drafters apply when it matches:
 *   no_draft  -> don't draft a reply at all (e.g. messages from your own team)
 *   pause     -> always draft but hold for review (e.g. VIP customers)
 *   auto_send -> eligible to send on its own (subject to reply mode)
 *   none      -> no identity action; only used to gate content rules
 * Shared by inbox/process (personal) and customer-service/process (desk). */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Knex = any

export type AudienceAction = 'none' | 'no_draft' | 'pause' | 'auto_send'

export type Audience = {
  id: string
  name: string
  action: AudienceAction
  emails: string[]
  crmListIds: string[]
  contactStages: string[]
  isDefaultTeam: boolean
}

// Strongest-wins precedence when a sender matches several audiences: withholding a
// draft beats holding for review beats auto-send.
const ACTION_RANK: Record<AudienceAction, number> = { no_draft: 3, pause: 2, auto_send: 1, none: 0 }

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

function normAction(v: unknown): AudienceAction {
  return v === 'no_draft' || v === 'pause' || v === 'auto_send' || v === 'none' ? v : 'no_draft'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAudience(row: Record<string, any>): Audience {
  return {
    id: String(row.id),
    name: String(row.name || ''),
    action: normAction(row.action),
    emails: asStringArray(row.emails),
    // Prefer the multi-list array; fall back to the legacy single crm_list_id.
    crmListIds: (() => {
      const arr = asStringArray(row.crm_list_ids)
      if (arr.length) return arr
      return row.crm_list_id ? [String(row.crm_list_id).toLowerCase()] : []
    })(),
    contactStages: asStringArray(row.contact_stages),
    isDefaultTeam: row.is_default_team === true,
  }
}

export async function loadAudiences(knex: Knex, orgId: string): Promise<Audience[]> {
  try {
    const rows = await knex('inbox_audiences').where('organization_id', orgId)
    return (rows as Record<string, unknown>[]).map(toAudience)
  } catch {
    // Table may not exist yet in an environment that hasn't been migrated.
    return []
  }
}

// Does the sender's email match this audience's email/domain list? An entry that
// starts with '@' is treated as a domain (matches anyone at that domain).
function emailMatches(emails: string[], senderEmail: string): boolean {
  if (!senderEmail) return false
  const e = senderEmail.toLowerCase()
  const domain = e.includes('@') ? e.slice(e.lastIndexOf('@')) : ''
  for (const entry of emails) {
    if (!entry) continue
    if (entry.startsWith('@')) {
      if (domain && domain === entry) return true
    } else if (entry === e) {
      return true
    }
  }
  return false
}

export type SenderMatch = {
  matchedIds: Set<string>
  teamMatched: boolean
  // Combined identity action across all matched audiences (strongest wins).
  action: AudienceAction
}

/* Resolve which audiences a sender belongs to, and the combined identity action.
 * senderEmail is the inbound from-address; contact is the resolved customer_entities
 * row (may be null). Only queries email_list_members when an audience is linked to a
 * CRM list AND we have a contactId. */
export async function resolveSenderAudiences(
  knex: Knex,
  orgId: string,
  audiences: Audience[],
  senderEmail: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contact: Record<string, any> | null,
): Promise<SenderMatch> {
  const matchedIds = new Set<string>()
  let teamMatched = false
  let bestAction: AudienceAction = 'none'
  if (!audiences.length) return { matchedIds, teamMatched, action: bestAction }

  const email = (senderEmail || contact?.primary_email || '').toString().toLowerCase()
  const stage = (contact?.lifecycle_stage || '').toString().trim().toLowerCase()
  const contactId = contact?.id ? String(contact.id) : null

  // CRM-list membership: one query across every list any audience links to, only
  // if we have a contact. list_id comparison is lowercased to match crmListIds.
  let memberListIds = new Set<string>()
  const allListIds = [...new Set(audiences.flatMap((a) => a.crmListIds))]
  if (contactId && allListIds.length) {
    try {
      const rows = await knex('email_list_members')
        .where('organization_id', orgId)
        .where('contact_id', contactId)
        .whereRaw('lower(list_id::text) = any(?)', [allListIds])
        .pluck('list_id')
      memberListIds = new Set((rows as string[]).map((x) => String(x).toLowerCase()))
    } catch {
      memberListIds = new Set()
    }
  }

  for (const a of audiences) {
    const byEmail = emailMatches(a.emails, email)
    const byStage = stage && a.contactStages.includes(stage)
    const byList = a.crmListIds.some((id) => memberListIds.has(id))
    if (byEmail || byStage || byList) {
      matchedIds.add(a.id)
      if (a.isDefaultTeam) teamMatched = true
      if (ACTION_RANK[a.action] > ACTION_RANK[bestAction]) bestAction = a.action
    }
  }
  return { matchedIds, teamMatched, action: bestAction }
}

/* Does a rule's audience reference match this sender? Used to gate CONTENT flag
 * scenarios by a named audience. Refs: 'aud:team' (the default team), 'aud:<id>'
 * (a specific audience). Non-audience refs ('anyone'/'new'/'existing') are handled
 * by the caller's existing new/existing logic and return true here. */
export function scenarioAudienceMatches(ref: string | undefined, match: SenderMatch): boolean {
  if (!ref || !ref.startsWith('aud:')) return true
  const key = ref.slice(4)
  if (key === 'team') return match.teamMatched
  return match.matchedIds.has(key)
}
