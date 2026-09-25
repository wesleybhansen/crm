/*
 * Whether the CRM should ask a member its "About Your Business" intake.
 *
 * Product audit 2026-09-25 (D6): a Launch Pad member finishes the Ideation
 * Lab, which briefs every Noli app server-side, and then the CRM asked the
 * same questions again. And before the Lab, the CRM ran its own nine-step
 * intake although the Lab is about to answer it. Both are gated here:
 *
 * - a profile a sibling app seeded (the internal seed-profile route) counts
 *   as briefed, so the member lands on the dashboard;
 * - a Launch Pad member who has not finished the Lab sees one honest line
 *   instead of the intake;
 * - everyone else keeps today's behaviour, and so does anyone whose Launch
 *   Pad state could not be read (fail open).
 */

export type IntakeGate = 'dashboard' | 'intake' | 'awaiting_lab'

export type IntakeProfile = {
  onboarding_complete?: boolean | null
  seeded_by?: string | null
  business_description?: string | null
} | null

export type LaunchpadBriefing = {
  /** A live Launch Pad subscription on one of the member's own orgs. */
  member: boolean
  /** The Lab (or Noli onboarding) has already briefed the apps. */
  briefed: boolean
} | null

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export function decideIntakeGate(profile: IntakeProfile, launchpad: LaunchpadBriefing): IntakeGate {
  if (profile?.onboarding_complete) return 'dashboard'
  // A server-side seed already told the CRM what the business does.
  if (profile && text(profile.seeded_by) && text(profile.business_description)) return 'dashboard'
  if (launchpad?.member) return launchpad.briefed ? 'dashboard' : 'awaiting_lab'
  return 'intake'
}

/**
 * Whether a seed from a sibling app is enough to skip the intake. Before
 * 2026-09-25 only a business name plus a pipeline counted, so the Lab's
 * seed (a description and who it is for, no pipeline) left the member in
 * the nine-step wizard.
 */
export function seedCompletesIntake(p: { hasBusinessName: boolean; hasPipeline: boolean; hasDescription: boolean }): boolean {
  return (p.hasBusinessName && p.hasPipeline) || p.hasDescription
}

/** Who seeded the profile, from the seed request's optional `source`. */
export function seededByFor(source: unknown): string {
  return source === 'launchpad-lab' ? 'launchpad-lab' : 'noli-hub'
}

const LIVE = new Set(['active', 'trialing', 'past_due'])

type Row = Record<string, unknown>
type Result = { data: unknown; error: unknown }
export type NoliCoreReader = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => PromiseLike<Result>
      in: (column: string, values: string[]) => PromiseLike<Result>
    }
  }
}

function rows(r: Result): Row[] {
  if (r.error) throw new Error('noli_core_read_failed')
  return Array.isArray(r.data) ? (r.data as Row[]) : []
}

/**
 * Reads only the signed-in member's own noli-core rows: their org
 * memberships, those orgs' subscriptions, their own Chief of Staff profile
 * and their own Lab sessions. Returns null on any read failure so the
 * caller falls back to today's behaviour.
 */
export async function readLaunchpadBriefing(client: NoliCoreReader, noliUserId: string): Promise<LaunchpadBriefing> {
  try {
    const orgIds = rows(await client.from('organization_members').select('organization_id').eq('user_id', noliUserId))
      .map((r) => text(r.organization_id))
      .filter(Boolean)
    if (orgIds.length === 0) return { member: false, briefed: false }

    const subs = rows(await client.from('subscriptions').select('status, metadata').in('organization_id', orgIds))
    const member = subs.some((s) => {
      const meta = (s.metadata ?? {}) as Row
      return LIVE.has(text(s.status)) && (meta.source === 'launch-pad' || Boolean(meta.launchpad_program))
    })
    if (!member) return { member: false, briefed: false }

    const cos = rows(await client.from('cos_business_profile').select('profile').eq('user_id', noliUserId))
    const whatYouDo = text(((cos[0]?.profile ?? {}) as Row).whatYouDo)
    if (whatYouDo) return { member: true, briefed: true }

    const sessions = rows(await client.from('launchpad_lab_sessions').select('status').eq('user_id', noliUserId))
    return { member: true, briefed: sessions.some((s) => s.status === 'complete') }
  } catch {
    return null
  }
}
