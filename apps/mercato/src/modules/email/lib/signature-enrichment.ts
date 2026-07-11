/* Signature enrichment: when a known contact emails in, parse their signature
 * block and fill in fields the CRM is missing (phone, job title, LinkedIn,
 * company name). Deterministic parsing only — no LLM, no cost, runs on every
 * inbound sync. Never overwrites a value the user already has. */

export type ParsedSignature = {
  phone?: string
  jobTitle?: string
  linkedinUrl?: string
  companyName?: string
}

const PHONE_RE = /(?:(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|\+\d{1,3}[\s.-]?\d{1,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4})/
const LINKEDIN_RE = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?/i
// "Title, Company" / "Title at Company" / "Title | Company" one-liners, plus bare-title lines.
const TITLE_WORDS = /\b(CEO|CTO|CFO|COO|CMO|founder|co-?founder|president|owner|principal|partner|director|manager|head of|lead|realtor|broker|agent|attorney|lawyer|consultant|coach|advisor|specialist|engineer|designer|developer|strategist|officer|vp|vice president)\b/i

function cleanLine(line: string): string {
  return line.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** Extract the likely signature block: the last ~12 non-quote lines after the
 * final sign-off cue, or just the tail of the message. */
function signatureLines(bodyText: string): string[] {
  const lines = bodyText
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((l) => l && !l.startsWith('>'))
  // Drop quoted history ("On ... wrote:")
  const quoteIdx = lines.findIndex((l) => /^On .{5,80} wrote:$/.test(l))
  const scoped = quoteIdx > 0 ? lines.slice(0, quoteIdx) : lines
  return scoped.slice(-12)
}

export function parseSignature(bodyText: string | null | undefined, senderName?: string | null): ParsedSignature {
  if (!bodyText) return {}
  const tail = signatureLines(bodyText)
  if (tail.length === 0) return {}
  const out: ParsedSignature = {}

  const joined = tail.join('\n')
  const li = joined.match(LINKEDIN_RE)
  if (li) {
    out.linkedinUrl = (li[0].startsWith('http') ? li[0] : `https://${li[0]}`).replace(/\/$/, '')
  }
  const phone = joined.match(PHONE_RE)
  if (phone) {
    const digits = phone[0].replace(/\D/g, '')
    // Real phone numbers, not zip codes/order ids.
    if (digits.length >= 10 && digits.length <= 13) out.phone = phone[0].trim()
  }

  // Title/company: look at the 3 lines right after the sender's name in the
  // signature (the classic block: Name / Title / Company), else any line with
  // a title word.
  const nameNorm = (senderName ?? '').trim().toLowerCase()
  let nameIdx = -1
  if (nameNorm.length > 3) {
    nameIdx = tail.findIndex((l) => l.toLowerCase() === nameNorm || l.toLowerCase().startsWith(nameNorm))
  }
  const candidates = nameIdx >= 0 ? tail.slice(nameIdx + 1, nameIdx + 4) : tail
  for (const line of candidates) {
    if (out.jobTitle) break
    if (line.length > 80 || /@|https?:\/\//.test(line)) continue
    const atSplit = line.split(/\s+at\s+|\s*[|,•]\s*/)
    if (TITLE_WORDS.test(atSplit[0]) && atSplit[0].length <= 60) {
      out.jobTitle = atSplit[0].trim()
      const rest = atSplit.slice(1).join(' ').trim()
      if (rest && rest.length <= 60 && !PHONE_RE.test(rest) && !/@/.test(rest)) {
        out.companyName = rest
      }
    }
  }

  return out
}

type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

/** Fill ONLY missing contact fields from a parsed signature. Returns which
 * fields were filled (for timeline logging). */
export async function enrichContactFromSignature(
  query: QueryFn,
  orgId: string,
  contactId: string,
  parsed: ParsedSignature,
): Promise<string[]> {
  if (!parsed.phone && !parsed.jobTitle && !parsed.linkedinUrl && !parsed.companyName) return []
  const filled: string[] = []

  const { rows: entityRows } = await query(
    `SELECT ce.primary_phone, cp.job_title, cp.linkedin_url
       FROM customer_entities ce
       LEFT JOIN customer_people cp ON cp.entity_id = ce.id
      WHERE ce.id = $1 AND ce.organization_id = $2 AND ce.deleted_at IS NULL`,
    [contactId, orgId],
  )
  const current = entityRows[0]
  if (!current) return []

  if (parsed.phone && !current.primary_phone) {
    await query(
      `UPDATE customer_entities SET primary_phone = $1, updated_at = now() WHERE id = $2 AND organization_id = $3`,
      [parsed.phone.slice(0, 40), contactId, orgId],
    )
    filled.push('phone')
  }
  if (parsed.jobTitle && !current.job_title) {
    await query(
      `UPDATE customer_people SET job_title = $1, updated_at = now() WHERE entity_id = $2 AND organization_id = $3`,
      [parsed.jobTitle.slice(0, 120), contactId, orgId],
    )
    filled.push('job title')
  }
  if (parsed.linkedinUrl && !current.linkedin_url) {
    await query(
      `UPDATE customer_people SET linkedin_url = $1, updated_at = now() WHERE entity_id = $2 AND organization_id = $3`,
      [parsed.linkedinUrl.slice(0, 300), contactId, orgId],
    )
    filled.push('LinkedIn')
  }
  // Company: record on the person's description-free path is complex (company
  // entities); v1 stores it on customer_people.company_name_hint only if the
  // column exists — handled by the same migration.
  if (parsed.companyName) {
    try {
      const { rows } = await query(
        `SELECT company_name_hint FROM customer_people WHERE entity_id = $1 AND organization_id = $2`,
        [contactId, orgId],
      )
      if (rows[0] && !rows[0].company_name_hint) {
        await query(
          `UPDATE customer_people SET company_name_hint = $1, updated_at = now() WHERE entity_id = $2 AND organization_id = $3`,
          [parsed.companyName.slice(0, 160), contactId, orgId],
        )
        filled.push('company')
      }
    } catch {
      // column missing (migration not applied) — skip silently
    }
  }

  return filled
}
