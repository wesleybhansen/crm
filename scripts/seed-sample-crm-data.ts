/**
 * Sample CRM data seed — a cohesive "book of business" demo so the redesigned
 * CRM looks alive in actual use. Scoped to Wesley's Workspace. Every row is
 * marked source='noli-sample' (or tied to a sample entity) so it is fully
 * removable: re-running this script deletes prior sample data first, and the
 * REMOVE block at the bottom shows the one cleanup query set.
 *
 * Run on the box:
 *   docker compose -f docker-compose.prod.yml exec app npx tsx scripts/seed-sample-crm-data.ts
 */
import { Pool } from 'pg'
import { randomUUID } from 'crypto'

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://crm:crm_dev_2026@localhost:5432/crm'
const ORG_ID = '9ab0d20b-830d-42e2-9833-fb33731564f5'      // Wesley's Workspace
const TENANT_ID = '22560ecc-ac23-466a-b047-0b8f23a259ff'
const SRC = 'noli-sample'
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 })

const now = new Date()
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000)
const daysAhead = (d: number) => new Date(now.getTime() + d * 86400_000)
const pick = <T,>(a: T[], i: number) => a[i % a.length]

async function main() {
  // ── 0. Clean prior sample data (FK-safe order) ──────────────────────────
  await cleanup()

  // ── 1. Pipeline + stages ────────────────────────────────────────────────
  const pipelineId = randomUUID()
  await q(
    `INSERT INTO customer_pipelines (id, organization_id, tenant_id, name, is_default, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [pipelineId, ORG_ID, TENANT_ID, 'Sales Pipeline', true, now]
  )
  const stageNames = ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost']
  const stageIds: Record<string, string> = {}
  for (let i = 0; i < stageNames.length; i++) {
    const id = randomUUID()
    stageIds[stageNames[i]] = id
    await q(
      `INSERT INTO customer_pipeline_stages (id, organization_id, tenant_id, pipeline_id, name, position, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [id, ORG_ID, TENANT_ID, pipelineId, stageNames[i], i, now]
    )
  }

  // ── 2. Companies (+ entity rows) ────────────────────────────────────────
  const companies = [
    { name: 'Harbor & Pine Studio', industry: 'Design Agency', domain: 'harborandpine.com', size: '11-50', rev: 1200000 },
    { name: 'Brightline Dental', industry: 'Healthcare', domain: 'brightlinedental.com', size: '11-50', rev: 2400000 },
    { name: 'Summit Gear Co', industry: 'Retail / E-commerce', domain: 'summitgear.co', size: '51-200', rev: 8600000 },
    { name: 'Maple Lane Bakery', industry: 'Food & Beverage', domain: 'maplelane.com', size: '1-10', rev: 480000 },
    { name: 'Cedar Creek Landscaping', industry: 'Home Services', domain: 'cedarcreekscapes.com', size: '11-50', rev: 1800000 },
    { name: 'Atlas Fitness', industry: 'Fitness', domain: 'atlasfit.com', size: '11-50', rev: 1500000 },
    { name: 'Nimbus Software', industry: 'SaaS', domain: 'nimbus.io', size: '51-200', rev: 12000000 },
    { name: 'Coastal Property Group', industry: 'Real Estate', domain: 'coastalpg.com', size: '11-50', rev: 3200000 },
  ]
  const companyEntityIds: string[] = []
  for (let i = 0; i < companies.length; i++) {
    const c = companies[i]
    const entityId = randomUUID()
    companyEntityIds.push(entityId)
    await q(
      `INSERT INTO customer_entities (id, organization_id, tenant_id, kind, display_name, primary_email, primary_phone, status, lifecycle_stage, source, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,'company',$4,$5,$6,'active',$7,$8,true,$9,$9)`,
      [entityId, ORG_ID, TENANT_ID, c.name, `hello@${c.domain}`, `(555) 0${i}0-12${i}3`, i < 5 ? 'customer' : 'prospect', SRC, daysAgo(120 - i * 8)]
    )
    await q(
      `INSERT INTO customer_companies (id, organization_id, tenant_id, entity_id, legal_name, brand_name, domain, website_url, industry, size_bucket, annual_revenue, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [randomUUID(), ORG_ID, TENANT_ID, entityId, `${c.name} LLC`, c.name, c.domain, `https://${c.domain}`, c.industry, c.size, c.rev, daysAgo(120 - i * 8)]
    )
  }

  // ── 3. People (2 per company) (+ entity rows) ───────────────────────────
  const first = ['Mara', 'James', 'Priya', 'Daniel', 'Sofia', 'Marcus', 'Elena', 'Tom', 'Grace', 'Andre', 'Nina', 'Carlos', 'Ruth', 'Leo', 'Hana', 'Owen']
  const last = ['Kessler', 'Whitfield', 'Nair', 'Brooks', 'Marin', 'Webb', 'Castro', 'Reilly', 'Okafor', 'Lindqvist', 'Patel', 'Mendez', 'Cohen', 'Tanaka', 'Bauer', 'Frost']
  const titles = ['Owner', 'Marketing Director', 'Operations Manager', 'Founder & CEO', 'Office Manager', 'VP Sales', 'Head of Growth', 'General Manager']
  const personEntityIds: string[] = []
  let p = 0
  for (let ci = 0; ci < companies.length; ci++) {
    for (let k = 0; k < 2; k++, p++) {
      const entityId = randomUUID()
      personEntityIds.push(entityId)
      const fn = pick(first, p), ln = pick(last, p)
      const email = `${fn.toLowerCase()}.${ln.toLowerCase()}@${companies[ci].domain}`
      await q(
        `INSERT INTO customer_entities (id, organization_id, tenant_id, kind, display_name, primary_email, primary_phone, status, lifecycle_stage, source, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,'person',$4,$5,$6,'active',$7,$8,true,$9,$9)`,
        [entityId, ORG_ID, TENANT_ID, `${fn} ${ln}`, email, `(555) 2${p}1-45${k}7`, ci < 5 ? 'customer' : 'lead', SRC, daysAgo(110 - p * 3)]
      )
      await q(
        `INSERT INTO customer_people (id, organization_id, tenant_id, entity_id, company_entity_id, first_name, last_name, job_title, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [randomUUID(), ORG_ID, TENANT_ID, entityId, companyEntityIds[ci], fn, ln, pick(titles, p), daysAgo(110 - p * 3)]
      )
      // engagement score
      await q(
        `INSERT INTO contact_engagement_scores (id, organization_id, tenant_id, contact_id, score, last_activity_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
        [randomUUID(), ORG_ID, TENANT_ID, entityId, 35 + ((p * 7) % 60), daysAgo(p % 14), daysAgo(110 - p * 3)]
      )
    }
  }

  // ── 4. Deals across stages ──────────────────────────────────────────────
  const dealPlan = [
    { co: 0, title: 'Brand refresh + website', stage: 'Proposal', val: 18000, prob: 60, close: 18 },
    { co: 1, title: 'Patient reactivation campaign', stage: 'Negotiation', val: 9500, prob: 75, close: 9 },
    { co: 2, title: 'Q3 paid social retainer', stage: 'Qualified', val: 24000, prob: 40, close: 30 },
    { co: 3, title: 'Local SEO + content', stage: 'Lead', val: 3600, prob: 20, close: 45 },
    { co: 4, title: 'Spring lead-gen funnel', stage: 'Closed Won', val: 14000, prob: 100, close: -12 },
    { co: 5, title: 'Membership growth program', stage: 'Proposal', val: 12000, prob: 55, close: 21 },
    { co: 6, title: 'Lifecycle email build-out', stage: 'Negotiation', val: 32000, prob: 70, close: 14 },
    { co: 7, title: 'Listings video package', stage: 'Qualified', val: 7800, prob: 45, close: 28 },
    { co: 0, title: 'Ongoing content retainer', stage: 'Closed Won', val: 4800, prob: 100, close: -3 },
    { co: 2, title: 'Marketplace expansion ads', stage: 'Lead', val: 15000, prob: 15, close: 60 },
    { co: 5, title: 'Referral program setup', stage: 'Closed Lost', val: 6000, prob: 0, close: -20 },
    { co: 6, title: 'Annual platform + services', stage: 'Negotiation', val: 48000, prob: 80, close: 11 },
  ]
  const dealIds: string[] = []
  for (let i = 0; i < dealPlan.length; i++) {
    const d = dealPlan[i]
    const id = randomUUID()
    dealIds.push(id)
    const status = d.stage === 'Closed Won' ? 'won' : d.stage === 'Closed Lost' ? 'lost' : 'open'
    await q(
      `INSERT INTO customer_deals (id, organization_id, tenant_id, title, description, status, pipeline_stage, pipeline_id, pipeline_stage_id, value_amount, value_currency, probability, expected_close_at, source, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'USD',$11,$12,$13,$14,$14)`,
      [id, ORG_ID, TENANT_ID, `${companies[d.co].name} — ${d.title}`, `${d.title} for ${companies[d.co].name}.`, status, d.stage, pipelineId, stageIds[d.stage], d.val, d.prob, daysAhead(d.close), SRC, daysAgo(40 - i * 2)]
    )
  }

  // ── 5. Activities (email/call/meeting) tied to people + deals ───────────
  const acts = [
    { type: 'email', subject: 'Intro + next steps', body: 'Sent over the proposal recap and a few times to connect this week.' },
    { type: 'call', subject: 'Discovery call', body: 'Walked through goals, current funnel, and budget. Strong fit.' },
    { type: 'meeting', subject: 'Kickoff meeting', body: 'Aligned on scope, timeline, and success metrics.' },
    { type: 'email', subject: 'Proposal sent', body: 'Shared the full proposal with pricing options.' },
    { type: 'call', subject: 'Follow-up', body: 'Checked in on the proposal; addressing two questions on scope.' },
    { type: 'note', subject: 'Context', body: 'Prefers async updates over email. Decision by end of month.' },
  ]
  let a = 0
  for (let i = 0; i < dealIds.length; i++) {
    const personIdx = (dealPlan[i].co * 2) % personEntityIds.length
    for (let j = 0; j < 2; j++, a++) {
      const act = pick(acts, a)
      await q(
        `INSERT INTO customer_activities (id, organization_id, tenant_id, entity_id, deal_id, activity_type, subject, body, occurred_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)`,
        [randomUUID(), ORG_ID, TENANT_ID, personEntityIds[personIdx], dealIds[i], act.type, act.subject, act.body, daysAgo(30 - a)]
      )
    }
  }

  // ── 6. Tasks (follow-ups) ───────────────────────────────────────────────
  const taskPlan = [
    { title: 'Send revised proposal', deal: 0, due: 2, done: false },
    { title: 'Schedule contract signing', deal: 1, due: 1, done: false },
    { title: 'Prep paid-social audit', deal: 2, due: 4, done: false },
    { title: 'Follow up on SEO scope', deal: 3, due: 5, done: false },
    { title: 'Onboarding kickoff email', deal: 4, due: -2, done: true },
    { title: 'Build membership offer', deal: 5, due: 3, done: false },
    { title: 'Map lifecycle email flows', deal: 6, due: 6, done: false },
    { title: 'Confirm shoot date', deal: 7, due: 7, done: false },
    { title: 'Quarterly check-in call', deal: 8, due: 9, done: false },
    { title: 'Send case study', deal: 11, due: 1, done: false },
  ]
  for (let i = 0; i < taskPlan.length; i++) {
    const t = taskPlan[i]
    const contactIdx = (dealPlan[t.deal].co * 2) % personEntityIds.length
    await q(
      `INSERT INTO tasks (id, tenant_id, organization_id, title, description, contact_id, deal_id, due_date, is_done, completed_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [randomUUID(), TENANT_ID, ORG_ID, t.title, `Re: ${companies[dealPlan[t.deal].co].name}`, personEntityIds[contactIdx], dealIds[t.deal], daysAhead(t.due), t.done, t.done ? daysAgo(2) : null, daysAgo(8 - i)]
    )
  }

  // ── 7. Notes on a few contacts ──────────────────────────────────────────
  const notes = [
    'Met at the regional small-business expo. Warm intro from a mutual contact.',
    'Budget approved for Q3. Wants to start with a pilot before the full retainer.',
    'Very responsive. Prefers a quick weekly call over long email threads.',
    'Decision-maker is the owner; the office manager handles scheduling.',
    'Renewal coming up in 60 days — flag for an upsell conversation.',
    'Price-sensitive but values done-for-you. Lead with the time savings.',
  ]
  for (let i = 0; i < notes.length; i++) {
    await q(
      `INSERT INTO contact_notes (id, tenant_id, organization_id, contact_id, content, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [randomUUID(), TENANT_ID, ORG_ID, personEntityIds[i * 2 % personEntityIds.length], notes[i], daysAgo(20 - i * 2)]
    )
  }

  // ── 8. Tags ─────────────────────────────────────────────────────────────
  const tags = [
    { slug: 'sample-vip', label: 'VIP', color: '#8b5cf6' },
    { slug: 'sample-hot-lead', label: 'Hot Lead', color: '#ef4444' },
    { slug: 'sample-renewal', label: 'Renewal', color: '#10b981' },
  ]
  for (const t of tags) {
    await q(
      `INSERT INTO customer_tags (id, organization_id, tenant_id, slug, label, color, description, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), ORG_ID, TENANT_ID, t.slug, t.label, t.color, 'noli-sample', now]
    )
  }

  const counts = await pool.query(
    `select
       (select count(*) from customer_entities where organization_id=$1 and source=$2) as entities,
       (select count(*) from customer_deals where organization_id=$1 and source=$2) as deals,
       (select count(*) from customer_pipeline_stages where pipeline_id=$3) as stages`,
    [ORG_ID, SRC, pipelineId]
  )
  console.log('SEED DONE', counts.rows[0], 'companies:', companies.length, 'people:', personEntityIds.length, 'tasks:', taskPlan.length, 'notes:', notes.length)
  await pool.end()
}

function q(text: string, params: unknown[]) { return pool.query(text, params) }

async function cleanup() {
  // delete sample rows + everything tied to sample entities/deals
  await pool.query(`delete from customer_activities where organization_id=$1 and (deal_id in (select id from customer_deals where organization_id=$1 and source=$2) or entity_id in (select id from customer_entities where organization_id=$1 and source=$2))`, [ORG_ID, SRC])
  await pool.query(`delete from tasks where organization_id=$1 and (deal_id in (select id from customer_deals where organization_id=$1 and source=$2) or contact_id in (select id from customer_entities where organization_id=$1 and source=$2))`, [ORG_ID, SRC])
  await pool.query(`delete from contact_notes where organization_id=$1 and contact_id in (select id from customer_entities where organization_id=$1 and source=$2)`, [ORG_ID, SRC])
  await pool.query(`delete from contact_engagement_scores where organization_id=$1 and contact_id in (select id from customer_entities where organization_id=$1 and source=$2)`, [ORG_ID, SRC])
  await pool.query(`delete from customer_deals where organization_id=$1 and source=$2`, [ORG_ID, SRC])
  await pool.query(`delete from customer_people where organization_id=$1 and entity_id in (select id from customer_entities where organization_id=$1 and source=$2)`, [ORG_ID, SRC])
  await pool.query(`delete from customer_companies where organization_id=$1 and entity_id in (select id from customer_entities where organization_id=$1 and source=$2)`, [ORG_ID, SRC])
  await pool.query(`delete from customer_entities where organization_id=$1 and source=$2`, [ORG_ID, SRC])
  await pool.query(`delete from customer_pipeline_stages where pipeline_id in (select id from customer_pipelines where organization_id=$1 and name='Sales Pipeline')`, [ORG_ID])
  await pool.query(`delete from customer_pipelines where organization_id=$1 and name='Sales Pipeline'`, [ORG_ID])
  await pool.query(`delete from customer_tags where organization_id=$1 and description='noli-sample'`, [ORG_ID])
}

main().catch((e) => { console.error(e); process.exit(1) })
