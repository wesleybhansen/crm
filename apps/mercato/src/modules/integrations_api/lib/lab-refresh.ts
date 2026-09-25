import crypto from 'crypto'
import {
  buildCrmFirstValueDraft,
  isLegacyNoliFirstValueTemplate,
  NOLI_FIRST_VALUE_TEMPLATE_MARKER,
  type CrmFirstValueDraft,
  type NoliOnboardingSeed,
} from './onboarding-seed'

/*
 * The Launch Pad's Ideation Lab is authoritative for the idea (orchestrator
 * e2e 2026-09-25): a member who finishes a second Lab idea saw the CRM keep
 * the first one, because the seed only ever filled blank fields. A seed
 * with source "launchpad-lab" now replaces the idea fields, never with a
 * blank, and leaves everything else the member set (pipeline, socials,
 * brand, website, persona) to the fill-blanks-only rule. Every other
 * source keeps fill-blanks-only for every field.
 */

export const LAB_SOURCE = 'launchpad-lab'

/** The profile fields that describe the idea itself. */
export const LAB_IDEA_FIELDS = ['businessName', 'businessDescription', 'idealClients'] as const
export type LabIdeaField = (typeof LAB_IDEA_FIELDS)[number]

export function isLabSource(source: unknown): boolean {
  return source === LAB_SOURCE
}

const has = (v: unknown) =>
  Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v)

/**
 * Whether one incoming value should be written. Lab idea fields overwrite a
 * different non-empty value; everything else fills only an empty field.
 */
export function shouldWriteField(
  field: string,
  existingVal: unknown,
  incoming: unknown,
  labAuthoritative: boolean,
): boolean {
  if (!has(incoming)) return false
  if (!has(existingVal)) return true
  if (labAuthoritative && (LAB_IDEA_FIELDS as readonly string[]).includes(field)) {
    return typeof existingVal === 'string' && typeof incoming === 'string'
      ? existingVal.trim() !== incoming.trim()
      : JSON.stringify(existingVal) !== JSON.stringify(incoming)
  }
  return false
}

/** Who the idea is for: the Lab's customers line, else its resolved audience. */
export function incomingIdealClients(body: Record<string, unknown>): unknown {
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v : '')
  return pick(body.idealClients) || pick(body.customers) || pick(body.audience)
}

const FINGERPRINT_PREFIX = '<!-- noli:first-value-sha:'

function digest(subject: string, bodyHtmlWithoutFingerprint: string): string {
  return crypto.createHash('sha256').update(`${subject}\n${bodyHtmlWithoutFingerprint}`).digest('hex').slice(0, 32)
}

function stripFingerprint(bodyHtml: string): string {
  return bodyHtml
    .split('\n')
    .filter((line) => !line.startsWith(FINGERPRINT_PREFIX))
    .join('\n')
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The template HTML the seed writes, without its fingerprint line. */
export function renderFirstValueHtml(draft: CrmFirstValueDraft): string {
  return [
    NOLI_FIRST_VALUE_TEMPLATE_MARKER,
    ...draft.body.split(/\n{2,}/).map((paragraph) => `<p>${esc(paragraph).replace(/\n/g, '<br>')}</p>`),
  ].join('\n')
}

/**
 * The template HTML with a fingerprint of the exact subject and body the
 * seed wrote, so a later seed can tell an untouched draft from one the
 * member edited.
 */
export function renderFingerprintedFirstValueHtml(draft: CrmFirstValueDraft): string {
  const html = renderFirstValueHtml(draft)
  return `${html}\n${FINGERPRINT_PREFIX}${digest(draft.subject, html)} -->`
}

/**
 * Whether the seeded follow-up template is still exactly what a seed wrote.
 * Templates written before fingerprints existed count as untouched only when
 * they match, byte for byte, the draft built from the profile as it stood
 * before this seed (or the legacy v1 wording).
 */
export function isUneditedSeedTemplate(
  template: { subject: string; bodyHtml: string },
  priorSeed: NoliOnboardingSeed | null,
): boolean {
  const { subject, bodyHtml } = template
  const line = bodyHtml.split('\n').find((l) => l.startsWith(FINGERPRINT_PREFIX))
  if (line) {
    const stored = line.slice(FINGERPRINT_PREFIX.length).replace(/\s*-->\s*$/, '')
    return stored === digest(subject, stripFingerprint(bodyHtml))
  }
  if (isLegacyNoliFirstValueTemplate(subject, bodyHtml)) return true
  if (!priorSeed) return false
  const priorDraft = buildCrmFirstValueDraft(priorSeed)
  return subject === priorDraft.subject && bodyHtml === renderFirstValueHtml(priorDraft)
}
