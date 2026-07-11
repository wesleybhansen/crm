import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

/* Behavior-suggested automations: watch what the user does repeatedly by hand
 * and offer to automate it. Deterministic SQL pattern mining over the last 90
 * days — no LLM, no cost. Each suggestion ships with a prefilled rule the UI
 * can create with one click via the existing automation-rules POST. */

export const metadata = {
  path: '/sequences/automation-rules/suggestions',
  GET: { requireAuth: true },
}

type Suggestion = {
  id: string
  title: string
  description: string
  occurrences: number
  rule: {
    name: string
    description: string
    triggerType: string
    triggerConfig: Record<string, unknown>
    actionType: string
    actionConfig: Record<string, unknown>
  }
}

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  // Patterns 1 (stage→tag) and 2 (deal-won→task) are suppressed until their
  // automation triggers are dispatched to the executor (today only
  // form_submitted fires). Non-literal so TS keeps auth narrowed in the blocks.
  const WIRED_PATTERNS_ONLY: boolean = true
  try {
    const knex = ((await createRequestContainer()).resolve('em') as EntityManager).getKnex()
    const suggestions: Suggestion[] = []
    const since = new Date(Date.now() - 90 * 86400_000)

    // Existing rules — don't suggest what's already automated.
    const rules = await knex('automation_rules')
      .where('organization_id', auth.orgId)
      .select('trigger_type', 'action_type', 'action_config', 'trigger_config')
    const hasRule = (triggerType: string, actionType: string, match?: (ac: any, tc: any) => boolean) =>
      rules.some((r: any) => {
        if (r.trigger_type !== triggerType || r.action_type !== actionType) return false
        if (!match) return true
        const ac = typeof r.action_config === 'string' ? JSON.parse(r.action_config || '{}') : (r.action_config ?? {})
        const tc = typeof r.trigger_config === 'string' ? JSON.parse(r.trigger_config || '{}') : (r.trigger_config ?? {})
        return match(ac, tc)
      })

    // ── Pattern 1: after moving a contact to stage X, you add tag Y ──
    // SUPPRESSED: stage_change automation triggers are not dispatched to the
    // executor yet, so a created rule would never fire. Re-enable when the
    // stage-change dispatch is wired.
    if (!WIRED_PATTERNS_ONLY) try {
      const tagAfterStage = await knex.raw(
        `SELECT e.metadata->>'to' AS to_stage, t.label AS tag_label, t.slug AS tag_slug,
                count(DISTINCT e.contact_id) AS n
           FROM contact_timeline_events e
           JOIN customer_tag_assignments a
             ON a.entity_id = e.contact_id
            AND a.organization_id = e.organization_id
            AND a.created_at BETWEEN e.created_at AND e.created_at + interval '48 hours'
           JOIN customer_tags t ON t.id = a.tag_id
          WHERE e.organization_id = ?
            AND e.event_type = 'stage_change'
            AND e.created_at >= ?
            AND e.metadata->>'to' IS NOT NULL
          GROUP BY 1, 2, 3
         HAVING count(DISTINCT e.contact_id) >= 3
          ORDER BY n DESC
          LIMIT 3`,
        [auth.orgId, since],
      )
      for (const row of tagAfterStage.rows ?? []) {
        if (hasRule('stage_change', 'add_tag', (ac) => (ac.tagName ?? ac.tag ?? '').toLowerCase() === String(row.tag_label).toLowerCase())) continue
        suggestions.push({
          id: `stage-tag-${row.to_stage}-${row.tag_slug}`,
          title: `Auto-tag "${row.tag_label}" when a contact reaches ${row.to_stage}`,
          description: `You added the "${row.tag_label}" tag shortly after moving a contact to ${row.to_stage} ${row.n} times in the last 90 days. This can happen automatically.`,
          occurrences: Number(row.n),
          rule: {
            name: `Tag "${row.tag_label}" on ${row.to_stage}`,
            description: 'Suggested from your repeated manual pattern.',
            triggerType: 'stage_change',
            triggerConfig: { stage: row.to_stage },
            actionType: 'add_tag',
            actionConfig: { tagName: row.tag_label },
          },
        })
      }
    } catch { /* pattern query failed (schema variance) — skip */ }

    // ── Pattern 2: after winning a deal, you create a task ──
    // SUPPRESSED: deal_won automation triggers are not dispatched to the
    // executor yet (only form_submitted is). Re-enable when wired.
    if (!WIRED_PATTERNS_ONLY) try {
      const taskAfterWin = await knex.raw(
        `SELECT count(*) AS n
           FROM customer_deals d
           JOIN tasks t
             ON t.deal_id = d.id
            AND t.organization_id = d.organization_id
            AND t.created_at BETWEEN d.updated_at AND d.updated_at + interval '48 hours'
          WHERE d.organization_id = ?
            AND d.status = 'win'
            AND d.updated_at >= ?
            AND t.deleted_at IS NULL`,
        [auth.orgId, since],
      )
      const n = Number(taskAfterWin.rows?.[0]?.n ?? 0)
      if (n >= 3 && !hasRule('deal_won', 'create_task')) {
        suggestions.push({
          id: 'won-task',
          title: 'Auto-create a follow-up task when you win a deal',
          description: `You created a task right after winning a deal ${n} times in the last 90 days. A rule can create it for you the moment a deal is won.`,
          occurrences: n,
          rule: {
            name: 'Follow-up task on won deal',
            description: 'Suggested from your repeated manual pattern.',
            triggerType: 'deal_won',
            triggerConfig: {},
            actionType: 'create_task',
            actionConfig: { title: 'Kick off onboarding for {{firstName}}' },
          },
        })
      }
    } catch { /* skip */ }

    // ── Pattern 3: after a form submission, you enroll the contact in the same sequence ──
    try {
      const seqAfterForm = await knex.raw(
        `SELECT en.sequence_id, s.name AS sequence_name, count(DISTINCT en.contact_id) AS n
           FROM form_submissions f
           JOIN sequence_enrollments en
             ON en.contact_id = f.contact_id
            AND en.organization_id = f.organization_id
            AND en.enrolled_at BETWEEN f.created_at AND f.created_at + interval '48 hours'
           JOIN sequences s ON s.id = en.sequence_id
          WHERE f.organization_id = ?
            AND f.created_at >= ?
            AND f.contact_id IS NOT NULL
          GROUP BY 1, 2
         HAVING count(DISTINCT en.contact_id) >= 3
          ORDER BY n DESC
          LIMIT 2`,
        [auth.orgId, since],
      )
      for (const row of seqAfterForm.rows ?? []) {
        if (hasRule('form_submitted', 'enroll_in_sequence', (ac) => ac.sequenceId === row.sequence_id)) continue
        suggestions.push({
          id: `form-seq-${row.sequence_id}`,
          title: `Auto-enroll form leads in "${row.sequence_name}"`,
          description: `You enrolled ${row.n} form leads into "${row.sequence_name}" by hand in the last 90 days. New form submissions can enroll automatically.`,
          occurrences: Number(row.n),
          rule: {
            name: `Enroll form leads in ${row.sequence_name}`,
            description: 'Suggested from your repeated manual pattern.',
            triggerType: 'form_submitted',
            triggerConfig: {},
            actionType: 'enroll_in_sequence',
            actionConfig: { sequenceId: row.sequence_id },
          },
        })
      }
    } catch { /* skip */ }

    return NextResponse.json({ ok: true, data: suggestions.slice(0, 5) })
  } catch (error) {
    console.error('[automation-rules.suggestions]', error)
    return NextResponse.json({ ok: true, data: [] })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sequences',
  summary: 'Automation suggestions mined from repeated manual behavior',
  methods: {
    GET: { summary: 'Automation suggestions mined from repeated manual behavior' },
  },
}
