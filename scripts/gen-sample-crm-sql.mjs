/* Generates SQL to seed a cohesive sample CRM dataset into Wesley's Workspace.
 * No DB connection — just emits SQL to stdout. Pipe into psql:
 *   node scripts/gen-sample-crm-sql.mjs > /tmp/crm-seed.sql
 *   docker compose -f docker-compose.prod.yml exec -T postgres psql -U crm -d crm < /tmp/crm-seed.sql
 * Every row is source='noli-sample' (or tied to a sample entity) so it is
 * fully removable; the script DELETEs prior sample data first (idempotent).
 */
import { randomUUID } from 'crypto'

// Org is parametrized: SEED_ORG env overrides (both Wesley's orgs share this tenant).
// weshansen123@yahoo.com test account => org f2d42b93 ("Wes").
const ORG = process.env.SEED_ORG || 'f2d42b93-6890-4e25-9647-5aa85a03a765'
const TEN = '22560ecc-ac23-466a-b047-0b8f23a259ff'
const SRC = 'noli-sample'
const CLEANUP_ONLY = process.env.CLEANUP_ONLY === '1'
const out = []
const E = (s) => s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`
const D = (dt) => `'${dt.toISOString()}'`
const now = new Date()
const dAgo = (d) => new Date(now.getTime() - d * 86400000)
const dAhead = (d) => new Date(now.getTime() + d * 86400000)
const pick = (a, i) => a[i % a.length]

out.push('BEGIN;')

// ── cleanup prior sample data (FK-safe) ──
out.push(`DELETE FROM customer_activities WHERE organization_id=${E(ORG)} AND (deal_id IN (SELECT id FROM customer_deals WHERE organization_id=${E(ORG)} AND source=${E(SRC)}) OR entity_id IN (SELECT id FROM customer_entities WHERE organization_id=${E(ORG)} AND source=${E(SRC)}));`)
out.push(`DELETE FROM tasks WHERE organization_id=${E(ORG)} AND (deal_id IN (SELECT id FROM customer_deals WHERE organization_id=${E(ORG)} AND source=${E(SRC)}) OR contact_id IN (SELECT id FROM customer_entities WHERE organization_id=${E(ORG)} AND source=${E(SRC)}));`)
out.push(`DELETE FROM contact_notes WHERE organization_id=${E(ORG)} AND contact_id IN (SELECT id FROM customer_entities WHERE organization_id=${E(ORG)} AND source=${E(SRC)});`)
out.push(`DELETE FROM contact_engagement_scores WHERE organization_id=${E(ORG)} AND contact_id IN (SELECT id FROM customer_entities WHERE organization_id=${E(ORG)} AND source=${E(SRC)});`)
out.push(`DELETE FROM customer_deals WHERE organization_id=${E(ORG)} AND source=${E(SRC)};`)
out.push(`DELETE FROM customer_people WHERE organization_id=${E(ORG)} AND entity_id IN (SELECT id FROM customer_entities WHERE organization_id=${E(ORG)} AND source=${E(SRC)});`)
out.push(`DELETE FROM customer_companies WHERE organization_id=${E(ORG)} AND entity_id IN (SELECT id FROM customer_entities WHERE organization_id=${E(ORG)} AND source=${E(SRC)});`)
out.push(`DELETE FROM customer_entities WHERE organization_id=${E(ORG)} AND source=${E(SRC)};`)
out.push(`DELETE FROM customer_pipeline_stages WHERE pipeline_id IN (SELECT id FROM customer_pipelines WHERE organization_id=${E(ORG)} AND name='Sales Pipeline');`)
out.push(`DELETE FROM customer_pipelines WHERE organization_id=${E(ORG)} AND name='Sales Pipeline';`)
out.push(`DELETE FROM customer_tags WHERE organization_id=${E(ORG)} AND description='noli-sample';`)
out.push(`DELETE FROM form_submissions WHERE organization_id=${E(ORG)} AND form_id IN (SELECT id FROM forms WHERE organization_id=${E(ORG)} AND description='noli-sample');`)
out.push(`DELETE FROM forms WHERE organization_id=${E(ORG)} AND description='noli-sample';`)
out.push(`DELETE FROM email_list_members WHERE organization_id=${E(ORG)} AND list_id IN (SELECT id FROM email_lists WHERE organization_id=${E(ORG)} AND description='noli-sample');`)
out.push(`DELETE FROM email_campaigns WHERE organization_id=${E(ORG)} AND category='noli-sample';`)
out.push(`DELETE FROM email_lists WHERE organization_id=${E(ORG)} AND description='noli-sample';`)

if (CLEANUP_ONLY) {
  out.push('COMMIT;')
  process.stdout.write(out.join('\n') + '\n')
  process.exit(0)
}

// ── pipeline + stages ──
const pipelineId = randomUUID()
out.push(`INSERT INTO customer_pipelines (id,organization_id,tenant_id,name,is_default,created_at,updated_at) VALUES (${E(pipelineId)},${E(ORG)},${E(TEN)},'Sales Pipeline',true,${D(now)},${D(now)});`)
const stageNames = ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost']
const stageIds = {}
stageNames.forEach((s, i) => {
  const id = randomUUID(); stageIds[s] = id
  out.push(`INSERT INTO customer_pipeline_stages (id,organization_id,tenant_id,pipeline_id,name,position,created_at,updated_at) VALUES (${E(id)},${E(ORG)},${E(TEN)},${E(pipelineId)},${E(s)},${i},${D(now)},${D(now)});`)
})

// ── companies ──
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
const companyEntityIds = []
companies.forEach((c, i) => {
  const eid = randomUUID(); companyEntityIds.push(eid)
  out.push(`INSERT INTO customer_entities (id,organization_id,tenant_id,kind,display_name,primary_email,primary_phone,status,lifecycle_stage,source,is_active,created_at,updated_at) VALUES (${E(eid)},${E(ORG)},${E(TEN)},'company',${E(c.name)},${E('hello@' + c.domain)},${E(`(555) 0${i}0-12${i}3`)},'active',${E(i < 5 ? 'customer' : 'prospect')},${E(SRC)},true,${D(dAgo(120 - i * 8))},${D(now)});`)
  out.push(`INSERT INTO customer_companies (id,organization_id,tenant_id,entity_id,legal_name,brand_name,domain,website_url,industry,size_bucket,annual_revenue,created_at,updated_at) VALUES (${E(randomUUID())},${E(ORG)},${E(TEN)},${E(eid)},${E(c.name + ' LLC')},${E(c.name)},${E(c.domain)},${E('https://' + c.domain)},${E(c.industry)},${E(c.size)},${c.rev},${D(dAgo(120 - i * 8))},${D(now)});`)
})

// ── people ──
const first = ['Mara', 'James', 'Priya', 'Daniel', 'Sofia', 'Marcus', 'Elena', 'Tom', 'Grace', 'Andre', 'Nina', 'Carlos', 'Ruth', 'Leo', 'Hana', 'Owen']
const last = ['Kessler', 'Whitfield', 'Nair', 'Brooks', 'Marin', 'Webb', 'Castro', 'Reilly', 'Okafor', 'Lindqvist', 'Patel', 'Mendez', 'Cohen', 'Tanaka', 'Bauer', 'Frost']
const titles = ['Owner', 'Marketing Director', 'Operations Manager', 'Founder & CEO', 'Office Manager', 'VP Sales', 'Head of Growth', 'General Manager']
const personEntityIds = []
let p = 0
for (let ci = 0; ci < companies.length; ci++) {
  for (let k = 0; k < 2; k++, p++) {
    const eid = randomUUID(); personEntityIds.push(eid)
    const fn = pick(first, p), ln = pick(last, p)
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}@${companies[ci].domain}`
    out.push(`INSERT INTO customer_entities (id,organization_id,tenant_id,kind,display_name,primary_email,primary_phone,status,lifecycle_stage,source,is_active,created_at,updated_at) VALUES (${E(eid)},${E(ORG)},${E(TEN)},'person',${E(fn + ' ' + ln)},${E(email)},${E(`(555) 2${p}1-45${k}7`)},'active',${E(ci < 5 ? 'customer' : 'lead')},${E(SRC)},true,${D(dAgo(110 - p * 3))},${D(now)});`)
    out.push(`INSERT INTO customer_people (id,organization_id,tenant_id,entity_id,company_entity_id,first_name,last_name,job_title,created_at,updated_at) VALUES (${E(randomUUID())},${E(ORG)},${E(TEN)},${E(eid)},${E(companyEntityIds[ci])},${E(fn)},${E(ln)},${E(pick(titles, p))},${D(dAgo(110 - p * 3))},${D(now)});`)
    out.push(`INSERT INTO contact_engagement_scores (id,organization_id,tenant_id,contact_id,score,last_activity_at,created_at,updated_at) VALUES (${E(randomUUID())},${E(ORG)},${E(TEN)},${E(eid)},${35 + ((p * 7) % 60)},${D(dAgo(p % 14))},${D(dAgo(110 - p * 3))},${D(now)});`)
  }
}

// ── deals ──
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
const dealIds = []
dealPlan.forEach((d, i) => {
  const id = randomUUID(); dealIds.push(id)
  const status = d.stage === 'Closed Won' ? 'won' : d.stage === 'Closed Lost' ? 'lost' : 'open'
  out.push(`INSERT INTO customer_deals (id,organization_id,tenant_id,title,description,status,pipeline_stage,pipeline_id,pipeline_stage_id,value_amount,value_currency,probability,expected_close_at,source,created_at,updated_at) VALUES (${E(id)},${E(ORG)},${E(TEN)},${E(companies[d.co].name + ' — ' + d.title)},${E(d.title + ' for ' + companies[d.co].name + '.')},${E(status)},${E(d.stage)},${E(pipelineId)},${E(stageIds[d.stage])},${d.val},'USD',${d.prob},${D(dAhead(d.close))},${E(SRC)},${D(dAgo(40 - i * 2))},${D(now)});`)
})

// ── activities ──
const acts = [
  { type: 'email', subject: 'Intro + next steps', body: 'Sent over the proposal recap and a few times to connect this week.' },
  { type: 'call', subject: 'Discovery call', body: 'Walked through goals, current funnel, and budget. Strong fit.' },
  { type: 'meeting', subject: 'Kickoff meeting', body: 'Aligned on scope, timeline, and success metrics.' },
  { type: 'email', subject: 'Proposal sent', body: 'Shared the full proposal with pricing options.' },
  { type: 'call', subject: 'Follow-up', body: 'Checked in on the proposal; addressing two questions on scope.' },
  { type: 'note', subject: 'Context', body: 'Prefers async updates over email. Decision by end of month.' },
]
let a = 0
dealIds.forEach((dealId, i) => {
  const personIdx = (dealPlan[i].co * 2) % personEntityIds.length
  for (let j = 0; j < 2; j++, a++) {
    const act = pick(acts, a)
    out.push(`INSERT INTO customer_activities (id,organization_id,tenant_id,entity_id,deal_id,activity_type,subject,body,occurred_at,created_at,updated_at) VALUES (${E(randomUUID())},${E(ORG)},${E(TEN)},${E(personEntityIds[personIdx])},${E(dealId)},${E(act.type)},${E(act.subject)},${E(act.body)},${D(dAgo(30 - a))},${D(dAgo(30 - a))},${D(now)});`)
  }
})

// ── tasks ──
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
taskPlan.forEach((t, i) => {
  const contactIdx = (dealPlan[t.deal].co * 2) % personEntityIds.length
  out.push(`INSERT INTO tasks (id,tenant_id,organization_id,title,description,contact_id,deal_id,due_date,is_done,completed_at,created_at,updated_at) VALUES (${E(randomUUID())},${E(TEN)},${E(ORG)},${E(t.title)},${E('Re: ' + companies[dealPlan[t.deal].co].name)},${E(personEntityIds[contactIdx])},${E(dealIds[t.deal])},${D(dAhead(t.due))},${t.done},${t.done ? D(dAgo(2)) : 'NULL'},${D(dAgo(8 - i))},${D(now)});`)
})

// ── notes ──
const notes = [
  'Met at the regional small-business expo. Warm intro from a mutual contact.',
  'Budget approved for Q3. Wants to start with a pilot before the full retainer.',
  'Very responsive. Prefers a quick weekly call over long email threads.',
  'Decision-maker is the owner; the office manager handles scheduling.',
  'Renewal coming up in 60 days, flag for an upsell conversation.',
  'Price-sensitive but values done-for-you. Lead with the time savings.',
]
notes.forEach((n, i) => {
  out.push(`INSERT INTO contact_notes (id,tenant_id,organization_id,contact_id,content,created_at,updated_at) VALUES (${E(randomUUID())},${E(TEN)},${E(ORG)},${E(personEntityIds[(i * 2) % personEntityIds.length])},${E(n)},${D(dAgo(20 - i * 2))},${D(now)});`)
})

// ── tags ──
const tags = [
  { slug: 'sample-vip', label: 'VIP', color: '#8b5cf6' },
  { slug: 'sample-hot-lead', label: 'Hot Lead', color: '#ef4444' },
  { slug: 'sample-renewal', label: 'Renewal', color: '#10b981' },
]
tags.forEach((t) => {
  out.push(`INSERT INTO customer_tags (id,organization_id,tenant_id,slug,label,color,description,created_at,updated_at) VALUES (${E(randomUUID())},${E(ORG)},${E(TEN)},${E(t.slug)},${E(t.label)},${E(t.color)},'noli-sample',${D(now)},${D(now)}) ON CONFLICT DO NOTHING;`)
})

// ── email lists + members ──
const jb = (o) => `${E(JSON.stringify(o))}::jsonb`
const listPlan = [
  { name: 'Newsletter Subscribers', n: 10 },
  { name: 'Active Clients', n: 6 },
]
const listIds = []
listPlan.forEach((l, li) => {
  const id = randomUUID(); listIds.push(id)
  out.push(`INSERT INTO email_lists (id,tenant_id,organization_id,name,description,source_type,member_count,created_at,updated_at) VALUES (${E(id)},${E(TEN)},${E(ORG)},${E(l.name)},'noli-sample','manual',${l.n},${D(dAgo(60 - li * 10))},${D(now)});`)
  for (let m = 0; m < l.n; m++) {
    const cid = personEntityIds[(li * 4 + m) % personEntityIds.length]
    out.push(`INSERT INTO email_list_members (id,list_id,contact_id,added_at,tenant_id,organization_id,created_at,updated_at) VALUES (${E(randomUUID())},${E(id)},${E(cid)},${D(dAgo(50 - m))},${E(TEN)},${E(ORG)},${D(dAgo(50 - m))},${D(now)});`)
  }
})

// ── email campaigns ──
const campPlan = [
  { name: 'Spring Promo Blast', subject: 'Your spring offer is here', status: 'sent', cat: 'noli-sample', sent: 28, stats: { recipients: 124, delivered: 121, opened: 67, clicked: 23 } },
  { name: 'June Newsletter', subject: "What's new this month", status: 'sent', cat: 'noli-sample', sent: 9, stats: { recipients: 118, delivered: 116, opened: 71, clicked: 18 } },
  { name: 'Win-back: lapsed clients', subject: 'We miss you — here is 20% off', status: 'scheduled', cat: 'noli-sample', sched: 3, stats: { recipients: 0 } },
  { name: 'Quarterly check-in (draft)', subject: 'How are things going?', status: 'draft', cat: 'noli-sample', stats: { recipients: 0 } },
]
campPlan.forEach((c, i) => {
  const body = `<p>Hi {{first_name}},</p><p>${c.subject}. Here is a quick update from the team.</p><p>Best,<br/>The team</p>`
  const sentAt = c.sent != null ? D(dAgo(c.sent)) : 'NULL'
  const schedAt = c.sched != null ? D(dAhead(c.sched)) : 'NULL'
  out.push(`INSERT INTO email_campaigns (id,tenant_id,organization_id,name,subject,body_html,status,category,scheduled_at,stats,created_at,updated_at,sent_at) VALUES (${E(randomUUID())},${E(TEN)},${E(ORG)},${E(c.name)},${E(c.subject)},${E(body)},${E(c.status)},${E(c.cat)},${schedAt},${jb(c.stats)},${D(dAgo(35 - i * 5))},${D(now)},${sentAt});`)
})

// ── form + submissions ──
const formId = randomUUID()
const formFields = [
  { id: 'fld_first', type: 'short_text', label: 'First Name', order: 0, width: 'half', required: true, crm_mapping: 'contact.first_name', placeholder: 'Jane' },
  { id: 'fld_last', type: 'short_text', label: 'Last Name', order: 1, width: 'half', required: true, crm_mapping: 'contact.last_name', placeholder: 'Doe' },
  { id: 'fld_email', type: 'email', label: 'Email', order: 2, width: 'full', required: true, crm_mapping: 'contact.email', placeholder: 'jane@company.com' },
  { id: 'fld_msg', type: 'long_text', label: 'How can we help?', order: 3, width: 'full', required: false, placeholder: 'Tell us a bit about your project' },
]
const formTheme = { font: 'Inter', corners: 'rounded', background: '#ffffff', primaryColor: '#7c3aed' }
const formSettings = { submitLabel: 'Send Message', createContact: true, successMessage: "Thanks! We'll be in touch soon." }
const subs = [
  { first: 'Dana', last: 'Reyes', email: 'dana.reyes@northwind.co', msg: 'Interested in a website refresh for our clinic.' },
  { first: 'Victor', last: 'Hahn', email: 'victor@greenfieldhomes.com', msg: 'Looking for help with lead generation this quarter.' },
  { first: 'Amara', last: 'Sy', email: 'amara@brightpath.io', msg: 'Can you share pricing for the email retainer?' },
]
out.push(`INSERT INTO forms (id,tenant_id,organization_id,name,slug,description,fields,theme,settings,status,view_count,submission_count,is_active,created_at,updated_at,published_at) VALUES (${E(formId)},${E(TEN)},${E(ORG)},'Contact Us','sample-contact-us','noli-sample',${jb(formFields)},${jb(formTheme)},${jb(formSettings)},'published',${184},${subs.length},true,${D(dAgo(40))},${D(now)},${D(dAgo(40))});`)
subs.forEach((s, i) => {
  out.push(`INSERT INTO form_submissions (id,tenant_id,organization_id,form_id,data,contact_id,created_at) VALUES (${E(randomUUID())},${E(TEN)},${E(ORG)},${E(formId)},${jb({ 'First Name': s.first, 'Last Name': s.last, Email: s.email, 'How can we help?': s.msg })},${E(personEntityIds[i % personEntityIds.length])},${D(dAgo(12 - i * 3))});`)
})

out.push('COMMIT;')
out.push(`SELECT 'entities' k, count(*) n FROM customer_entities WHERE organization_id=${E(ORG)} AND source=${E(SRC)} UNION ALL SELECT 'deals', count(*) FROM customer_deals WHERE organization_id=${E(ORG)} AND source=${E(SRC)} UNION ALL SELECT 'stages', count(*) FROM customer_pipeline_stages WHERE pipeline_id=${E(pipelineId)} UNION ALL SELECT 'activities', count(*) FROM customer_activities WHERE organization_id=${E(ORG)} AND deal_id IN (SELECT id FROM customer_deals WHERE source=${E(SRC)}) UNION ALL SELECT 'email_lists', count(*) FROM email_lists WHERE organization_id=${E(ORG)} AND description='noli-sample' UNION ALL SELECT 'campaigns', count(*) FROM email_campaigns WHERE organization_id=${E(ORG)} AND category='noli-sample' UNION ALL SELECT 'forms', count(*) FROM forms WHERE organization_id=${E(ORG)} AND description='noli-sample';`)

process.stdout.write(out.join('\n') + '\n')
