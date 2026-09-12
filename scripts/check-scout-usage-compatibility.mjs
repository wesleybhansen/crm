import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const ts = require('typescript')
const { NextResponse } = require('next/server')
const baselineCommit = 'a6e3a3228f0c27ecf66d401bc54f20ef80d1f330'
const artifactRoot = path.resolve(process.argv[2] ?? path.join(root, '.ai/qa/test-results/scout-usage-compatibility'))
const paths = {
  route: 'apps/mercato/src/modules/customers/api/ai/assistant/route.ts',
  observation: 'apps/mercato/src/modules/customers/lib/scout-usage-observation.ts',
  access: 'apps/mercato/src/lib/usage/provider-access.ts',
  persona: 'apps/mercato/src/modules/customers/api/ai/persona.ts',
  catalog: 'apps/mercato/src/modules/customers/lib/crm-tool-catalog.ts',
  meter: 'apps/mercato/src/lib/usage/meter.ts',
  logger: 'packages/shared/src/lib/noli/ai-usage.ts',
  consumer: 'apps/mercato/src/modules/customers/backend/assistant/page.tsx',
}
const hash = value => createHash('sha256').update(value).digest('hex')
const git = args => execFileSync('git', args, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
  env: { PATH: '/usr/bin:/bin:/usr/local/bin' },
})
const baselineSources = Object.fromEntries(Object.entries(paths)
  .filter(([name]) => name !== 'observation')
  .map(([name, relative]) => [name, git(['show', `${baselineCommit}:${relative}`])]))
const candidateSources = Object.fromEntries(Object.entries(paths)
  .map(([name, relative]) => [name, readFileSync(path.join(root, relative), 'utf8')]))

for (const name of ['access', 'persona', 'catalog', 'meter', 'logger', 'consumer']) {
  assert.equal(candidateSources[name], baselineSources[name], `Out-of-scope source changed: ${paths[name]}`)
}

function snapshot(value) {
  if (value === undefined) return { $undefined: true }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) }
  if (Array.isArray(value)) return Array.from(value, snapshot)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]))
  }
  return value
}

const auth = {
  sub: 'synthetic-user-1', orgId: 'synthetic-org-1', tenantId: 'synthetic-tenant-1',
  email: 'owner@example.test', roles: ['synthetic-owner'],
}
const baseBody = {
  messages: [
    { role: 'user', content: 'Show my pipeline overview.' },
    { role: 'assistant', content: 'I can review the current pipeline and next steps.' },
    { role: 'user', content: 'Tell me about Maria Chen' },
  ],
  currentPage: 'Synthetic CRM — Contacts',
  pageContext: { entityType: 'contact', entityId: 'synthetic-contact-1', pathname: '/backend/customers/people' },
}
const platformKeys = {
  GOOGLE_GENERATIVE_AI_API_KEY: 'synthetic-platform-google',
  OPENAI_API_KEY: 'synthetic-platform-openai',
  AI_MODEL: 'synthetic-gemini-model',
  OPENAI_FALLBACK_MODEL: 'synthetic-openai-model',
}
const ordinaryReply = '**Maria Chen** has a $2,400 open proposal.\n- Next: review the proposal on September 18.\n[Open Contacts](/backend/customers/people)'
const actionReply = 'First, create the contact.\n```crm-action\n{"type":"create_contact","data":{"name":"Taylor Rowan","email":"taylor@example.test"}}\n```\nThen create the task.\n```crm-action\n{"type":"create_task","data":{"title":"Send introduction","contactName":"Taylor Rowan"}}\n```'
const lookupReply = 'I will check the contact record.\n```crm-action\n{"type":"find_entity","data":{"entityType":"contact","query":"Maria Chen"}}\n```'
const terminalReply = '**Maria Chen** is the matching contact. The lookup confirms maria@example.test.\n[Open Contacts](/backend/customers/people)'

function gemini(text = ordinaryReply, usage = {
  promptTokenCount: 2400, cachedContentTokenCount: 1200, candidatesTokenCount: 140,
  thoughtsTokenCount: 20, totalTokenCount: 2560, toolUsePromptTokenCount: 0,
}) {
  return { payload: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage } }
}

function openai(text = ordinaryReply, usage = {
  prompt_tokens: 2400, completion_tokens: 160, total_tokens: 2560,
  prompt_tokens_details: { cached_tokens: 1200 }, completion_tokens_details: { reasoning_tokens: 20 },
}) {
  return { payload: { choices: [{ message: { content: text } }], usage } }
}

const providerError = (status, message, usageMetadata) => ({ status, payload: { error: { message }, usageMetadata } })
const allowed = { google: { allowed: true }, openai: { allowed: true } }
const byo = {
  google: { allowed: true, byoApiKey: 'synthetic-customer-google' },
  openai: { allowed: true, byoApiKey: 'synthetic-customer-openai' },
}
const fixtures = [
  { id: 'gemini-rich-context', responses: [gemini()], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'gemini-actions-preserved', responses: [gemini(actionReply)], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'model-defaults-preserved', env: { AI_MODEL: undefined, OPENAI_FALLBACK_MODEL: undefined }, responses: [providerError(429, 'synthetic rate limit'), openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'long-history-preserved', body: { ...baseBody, messages: [...Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Synthetic history turn ${index + 1}: ${'context retained without summarization '.repeat(50)}` })), ...baseBody.messages] }, responses: [gemini(actionReply)], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'gemini-first-part-and-candidate-preserved', responses: [{ payload: { candidates: [{ content: { parts: [{ text: ordinaryReply }, { text: 'Do not append a second part.' }] } }, { content: { parts: [{ text: 'Do not select the second candidate.' }] } }], usageMetadata: { promptTokenCount: 2400, candidatesTokenCount: 140 } } }], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'openai-first-choice-preserved', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined }, responses: [{ payload: { choices: [{ message: { content: ordinaryReply } }, { message: { content: 'Do not select the second choice.' } }], usage: { prompt_tokens: 2400, completion_tokens: 140 } } }], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'gemini-encryption-on', encryption: true, responses: [gemini()], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'cookie-auth-fallback', cookieAuth: true, responses: [gemini()], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'missing-auth-context', auth: null, responses: [gemini()], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'empty-conversation', body: { messages: [], pageContext: { pathname: '/backend/dashboards' } }, responses: [gemini()], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'invalid-messages', body: { messages: 'invalid' }, responses: [], expectedStatus: 400 },
  { id: 'malformed-request-json', malformedRequest: true, responses: [], expectedStatus: 500 },
  { id: 'data-query-failure', queryFailure: true, responses: [gemini()], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'gemini-byo-success', gates: byo, responses: [gemini()], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'openai-direct-platform', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined }, responses: [openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'openai-direct-byo', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined }, gates: { google: { allowed: true }, openai: byo.openai }, responses: [openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'gemini-429-openai-success', responses: [providerError(429, 'synthetic rate limit'), openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'gemini-500-openai-success', responses: [providerError(500, 'synthetic upstream failure'), openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'gemini-400-no-fallback', responses: [providerError(400, 'synthetic invalid argument')], expectedStatus: 500 },
  { id: 'gemini-200-error-no-fallback', responses: [providerError(200, 'synthetic invalid argument')], expectedStatus: 500 },
  { id: 'gemini-400-quota-fallback', responses: [providerError(400, 'synthetic quota'), openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'gemini-transport-fallback', responses: [{ transportError: true }, openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'gemini-timeout-fallback', responses: [{ timeout: true }, openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'gemini-json-delay', responses: [{ ...gemini(), jsonDelay: true }], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'gemini-invalid-json-fallback', responses: [{ invalidJson: true }, openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'gemini-empty-first-part-fallback', responses: [{ payload: { candidates: [{ content: { parts: [{ text: '' }, { text: 'Must not repair baseline extraction' }] } }], usageMetadata: { promptTokenCount: 2400, candidatesTokenCount: 20 } } }, openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'gemini-byo-platform-fallback-blocked', gates: { google: byo.google, openai: { allowed: true } }, responses: [providerError(429, 'synthetic rate limit')], expectedStatus: 402 },
  { id: 'gemini-byo-openai-byo', gates: byo, responses: [providerError(429, 'synthetic rate limit'), openai()], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'fallback-allowance-denied', gates: { google: { allowed: true }, openai: { allowed: false, message: 'synthetic allowance denied' } }, responses: [providerError(429, 'synthetic rate limit')], expectedStatus: 402 },
  { id: 'all-allowance-denied', gates: { google: { allowed: false }, openai: { allowed: false } }, responses: [], expectedStatus: 402 },
  { id: 'both-providers-rate-limited', responses: [providerError(429, 'synthetic rate limit'), providerError(429, 'synthetic quota')], expectedStatus: 200 },
  { id: 'both-providers-fail', responses: [providerError(503, 'synthetic unavailable'), providerError(500, 'synthetic OpenAI failure')], expectedStatus: 500 },
  { id: 'openai-empty-response', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined }, responses: [openai('')], expectedStatus: 500 },
  { id: 'openai-invalid-json', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined }, responses: [{ invalidJson: true }], expectedStatus: 500 },
  { id: 'openai-200-error', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined }, responses: [providerError(200, 'synthetic OpenAI error')], expectedStatus: 500 },
  { id: 'openai-timeout', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined }, responses: [{ timeout: true }], expectedStatus: 500 },
  { id: 'no-provider-keys', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined, OPENAI_API_KEY: undefined }, responses: [], expectedStatus: 200 },
  { id: 'fallback-key-unavailable', env: { OPENAI_API_KEY: undefined }, responses: [providerError(503, 'synthetic unavailable')], expectedStatus: 500 },
  { id: 'missing-gemini-usage', responses: [gemini(ordinaryReply, null)], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'missing-openai-usage', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined }, responses: [openai(ordinaryReply, null)], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'explicit-zero-usage', responses: [gemini(ordinaryReply, { promptTokenCount: 0, candidatesTokenCount: 0, cachedContentTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0, toolUsePromptTokenCount: 0 })], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'malformed-gemini-usage', responses: [gemini(ordinaryReply, { promptTokenCount: '2400', candidatesTokenCount: -3, cachedContentTokenCount: 0.5, thoughtsTokenCount: 'private-synthetic-usage-canary', totalTokenCount: 9007199254740992, toolUsePromptTokenCount: { private: 'synthetic-canary' } })], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'inconsistent-openai-usage', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined }, responses: [openai(ordinaryReply, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 2, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 9 } })], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'malformed-openai-usage', env: { GOOGLE_GENERATIVE_AI_API_KEY: undefined }, responses: [openai(ordinaryReply, { prompt_tokens: '24', completion_tokens: '10', prompt_tokens_details: ['private-synthetic-usage-canary'], completion_tokens_details: { reasoning_tokens: -1 }, total_tokens: 2.5 })], expectedStatus: 200, expectedProvider: 'openai' },
  { id: 'delayed-meter-not-awaited', meterMode: 'delayed', responses: [gemini()], expectedStatus: 200, expectedProvider: 'gemini' },
  { id: 'throwing-meter-no-output-change', meterMode: 'throw', responses: [gemini()], expectedStatus: 200, expectedProvider: 'gemini' },
]

function databaseRows(encryption) {
  const shared = { organization_id: auth.orgId, tenant_id: auth.tenantId, deleted_at: null, created_at: '2026-09-11T08:00:00.000Z' }
  const contactName = encryption ? 'cipher:Maria Chen' : 'Maria Chen'
  return {
    business_profiles: [{ ...shared, pipeline_mode: 'journey', pipeline_stages: '["Prospect","First Contact","Customer","VIP"]', ai_persona_name: 'Scout', ai_persona_style: 'professional', ai_custom_instructions: 'Use only the synthetic records supplied.', business_name: 'Synthetic Lantern Studio', business_type: 'Design', business_description: 'Synthetic small-business profile.' }],
    customer_entities: [
      { ...shared, id: 'synthetic-contact-1', kind: 'person', display_name: contactName, primary_email: encryption ? 'cipher:maria@example.test' : 'maria@example.test', primary_phone: '+1-202-555-0100', lifecycle_stage: 'Customer', source: 'synthetic-referral' },
      { ...shared, id: 'synthetic-company-1', kind: 'company', display_name: 'Synthetic Lantern Studio', primary_email: null },
      { ...shared, id: 'synthetic-other-org', organization_id: 'synthetic-other-org', kind: 'person', display_name: 'FOREIGN_ORG_CANARY', primary_email: 'foreign@example.test' },
    ],
    customer_deals: [{ ...shared, id: 'synthetic-deal-1', title: encryption ? 'cipher:Maria Chen proposal' : 'Maria Chen proposal', description: 'Synthetic design work', status: 'open', value_amount: 2400, pipeline_stage: 'Proposal', ai_summary: 'Waiting for proposal review.' }],
    tasks: [{ ...shared, id: 'synthetic-task-1', contact_id: 'synthetic-contact-1', title: 'Review proposal', is_done: false, due_date: '2026-09-18T12:00:00.000Z' }, { ...shared, title: 'Initial call', is_done: true }],
    invoices: [{ ...shared, invoice_number: 'SYNTHETIC-001', status: 'sent', total: 2400 }],
    payment_records: [{ ...shared, status: 'succeeded', amount: 800 }],
    products: [{ ...shared, name: 'Synthetic Design Session', price: 200, billing_type: 'one_time', is_active: true, trial_days: 0 }],
    events: [{ ...shared, title: 'Synthetic Planning Session', status: 'published', start_time: '2026-09-18T12:00:00.000Z', attendee_count: 3, capacity: 8 }],
    courses: [{ ...shared, title: 'Synthetic Design Basics', is_published: true, price: 50 }],
    surveys: [{ ...shared, title: 'Synthetic Feedback', is_active: true, response_count: 2 }],
    automation_rules: [{ ...shared, is_active: true }],
    chat_widgets: [{ ...shared, is_active: true }],
    users: [{ ...shared, id: auth.sub, name: 'Synthetic Owner' }],
    'customer_deal_people as cdp': [{ ...shared, 'cdp.person_entity_id': 'synthetic-contact-1', 'cd.organization_id': auth.orgId, title: 'Maria Chen proposal', status: 'open', value_amount: 2400, pipeline_stage: 'Proposal' }],
    'customer_tag_assignments as cta': [{ ...shared, 'cta.entity_id': 'synthetic-contact-1', 'cta.organization_id': auth.orgId, name: 'Synthetic Priority' }],
  }
}

function makeDatabase(trace, fixture) {
  const tables = databaseRows(fixture.encryption)
  const record = (kind, details = {}) => trace.push(snapshot({ kind, ...details }))
  const knex = table => {
    const operations = []
    let executed = false
    let resultPromise
    function execute() {
      if (executed) return resultPromise
      executed = true
      record('query', { table, operations })
      if (!(table in tables)) throw new Error(`Unexpected synthetic table: ${table}`)
      if (fixture.queryFailure && table === 'business_profiles') {
        resultPromise = Promise.reject(new Error('Synthetic database failure'))
        return resultPromise
      }
      let rows = structuredClone(tables[table])
      const read = (row, field) => row[field] ?? row[String(field).split('.').at(-1)]
      for (const [method, ...args] of operations) {
        if (method === 'where') rows = rows.filter(row => read(row, args[0]) === args[1])
        if (method === 'whereNull') rows = rows.filter(row => read(row, args[0]) == null)
        if (method === 'whereIn') rows = rows.filter(row => args[1].includes(read(row, args[0])))
        if (method === 'limit') rows = rows.slice(0, args[0])
      }
      if (operations.some(([method]) => method === 'count')) rows = [{ count: rows.length }]
      const sum = operations.find(([method]) => method === 'sum')
      if (sum) rows = [{ sum: rows.reduce((total, row) => total + Number(read(row, sum[1]) || 0), 0) }]
      const result = operations.some(([method]) => method === 'first') ? rows[0] : rows
      resultPromise = Promise.resolve(result)
      return resultPromise
    }
    const builder = Object.fromEntries(['where', 'whereNull', 'whereIn', 'orderBy', 'limit', 'select', 'join', 'count', 'sum', 'first'].map(method => [method, (...args) => {
      operations.push([method, ...args])
      return builder
    }]))
    builder.then = (resolve, reject) => execute().then(resolve, reject)
    builder.catch = reject => execute().catch(reject)
    return builder
  }
  return { getKnex() { record('em:getKnex'); return knex } }
}

function executeModule(source, filename, context, resolve) {
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    reportDiagnostics: true,
  })
  const errors = compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  assert.equal(errors.length, 0, `Transpile errors in ${filename}`)
  const module = { exports: {} }
  new vm.Script(`(function(exports, require, module) { ${compiled.outputText}\n})`, { filename })
    .runInContext(context)(module.exports, resolve, module)
  return module.exports
}

async function runRoute(version, fixture, turns = null) {
  const sources = version === 'baseline' ? baselineSources : candidateSources
  const trace = []
  const record = (kind, details = {}) => trace.push(snapshot({ kind, ...details }))
  const requests = []
  const responses = []
  const meterCalls = []
  const timers = new Map()
  const meterSettlements = []
  let timerId = 0
  let providerIndex = 0
  const gates = fixture.gates ?? allowed
  const fixtureAuth = Object.hasOwn(fixture, 'auth') ? fixture.auth : auth
  const em = makeDatabase(trace, fixture)
  const context = vm.createContext({
    process: { env: { ...platformKeys, ...fixture.env } },
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => record('console', { level, args: args.map(value => value instanceof Error ? { name: value.name, message: value.message } : String(value)) })])),
    AbortController: class extends AbortController {
      abort(...args) { record('abort'); return super.abort(...args) }
    },
    setTimeout(callback, milliseconds) {
      const id = ++timerId
      timers.set(id, { callback, milliseconds })
      record('timer:set', { id, milliseconds })
      return id
    },
    clearTimeout(id) { record('timer:clear', { id }); timers.delete(id) },
    fetch: async (url, options) => {
      const current = fixture.responses[providerIndex++]
      if (!current) throw new Error('Unplanned provider request blocked by synthetic harness')
      const request = { url: String(url), method: options.method, headers: [...new Headers(options.headers).entries()], rawHeaders: snapshot(options.headers), body: options.body, signalPresent: Boolean(options.signal), signalInitiallyAborted: options.signal?.aborted }
      requests.push(snapshot(request))
      record('fetch:start', { index: providerIndex, request })
      if (current.timeout) {
        assert.equal(timers.size, 1, 'Exactly one provider timeout must be active')
        for (const [id, timer] of timers) {
          assert.equal(timer.milliseconds, 30000)
          record('timer:fire', { id })
          timer.callback()
        }
        assert.equal(options.signal.aborted, true)
        record('fetch:reject', { index: providerIndex, reason: 'timeout' })
        throw new DOMException('Synthetic provider timeout', 'AbortError')
      }
      if (current.transportError) {
        record('fetch:reject', { index: providerIndex, reason: 'transport' })
        throw new Error('Synthetic transport failure')
      }
      const index = providerIndex
      const status = current.status ?? 200
      record('fetch:resolve', { index, status })
      return {
        status,
        ok: status >= 200 && status <= 299,
        json: async () => {
          record('provider:json:start', { index, activeTimerCount: timers.size })
          assert.equal(timers.size, 0, 'The baseline timeout ends before JSON parsing')
          if (current.jsonDelay) {
            await Promise.resolve()
            record('provider:json:delayed', { index, activeTimerCount: timers.size })
          }
          if (current.invalidJson) {
            record('provider:json:reject', { index })
            throw new SyntaxError('Synthetic invalid JSON')
          }
          record('provider:json:resolve', { index })
          return structuredClone(current.payload)
        },
      }
    },
  })
  const moduleCache = new Map()
  const knownModules = {
    '@/lib/usage/provider-access': 'access',
    '../persona': 'persona',
    '@/modules/customers/lib/crm-tool-catalog': 'catalog',
    '@/modules/customers/lib/scout-usage-observation': 'observation',
  }
  function resolve(specifier) {
    if (knownModules[specifier]) {
      const name = knownModules[specifier]
      assert.ok(sources[name], `Unavailable ${version} module ${name}`)
      if (!moduleCache.has(name)) moduleCache.set(name, executeModule(sources[name], paths[name], context, resolve))
      return moduleCache.get(name)
    }
    if (specifier === 'zod') return require('zod')
    if (specifier === 'next/server') return { NextResponse }
    if (specifier === '@open-mercato/shared/lib/auth/server') return { getAuthFromCookies: async () => { record('auth:cookie'); return structuredClone(fixtureAuth) } }
    if (specifier === '@/lib/usage/allowance') return {
      ALLOWANCE_BLOCK_MESSAGE: 'Synthetic allowance blocked',
      checkCustomersAiAllowance: async (checkedAuth, provider) => { record('allowance', { auth: checkedAuth, provider }); return structuredClone(gates[provider]) },
    }
    if (specifier === '@open-mercato/shared/lib/di/container') return {
      createRequestContainer: async () => {
        record('container:create')
        return { resolve: name => { record('container:resolve', { name }); assert.equal(name, 'em'); return em } }
      },
    }
    if (specifier === '@open-mercato/shared/lib/encryption/toggles') return { isTenantDataEncryptionEnabled: () => Boolean(fixture.encryption) }
    if (specifier === '@open-mercato/shared/lib/encryption/kms') return { createKmsService: () => { record('kms:create'); return {} } }
    if (specifier === '@open-mercato/shared/lib/encryption/tenantDataEncryptionService') return {
      TenantDataEncryptionService: class {
        async decryptEntityPayload(entity, payload, tenantId, orgId) {
          record('decrypt', { entity, payload, tenantId, orgId })
          return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value.replace(/^cipher:/, '') : value]))
        }
      },
    }
    if (specifier === '@/lib/usage/meter') return {
      meterCustomersAi(meterAuth, args) {
        meterCalls.push(snapshot({ auth: meterAuth, args }))
        record('meter:start', { callIndex: meterCalls.length })
        if (fixture.meterMode === 'throw') throw new Error('Synthetic synchronous metering failure')
        if (fixture.meterMode === 'delayed') return new Promise(resolveMeter => meterSettlements.push(resolveMeter))
        return Promise.resolve()
      },
    }
    throw new Error(`Unexpected module import blocked: ${specifier}`)
  }
  const route = executeModule(sources.route, paths.route, context, resolve)
  assert.deepEqual(snapshot(route.metadata), { path: '/ai/assistant', POST: { requireAuth: true } })
  const catalog = resolve('@/modules/customers/lib/crm-tool-catalog')
  assert.ok(catalog.CRM_TOOLS.length > 80, 'Full current tool catalog must be exercised')
  const turnBodies = turns ?? [fixture.body ?? baseBody]
  for (let index = 0; index < turnBodies.length; index += 1) {
    record('route:start', { turn: index + 1 })
    const body = typeof turnBodies[index] === 'function' ? turnBodies[index](responses) : turnBodies[index]
    const request = new Request('http://synthetic.invalid/api/ai/assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: fixture.malformedRequest ? '{' : JSON.stringify(body),
    })
    let deadline
    const timeout = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`${version}/${fixture.id}: route unexpectedly waited for unsettled work`)), 3000) })
    let response
    try {
      response = await Promise.race([route.POST(request, fixture.cookieAuth ? undefined : { auth: structuredClone(fixtureAuth) }), timeout])
    } finally {
      clearTimeout(deadline)
    }
    record('route:resolved', { turn: index + 1, meterStillPending: meterSettlements.length })
    const raw = await response.text()
    responses.push({ status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], raw, json: JSON.parse(raw) })
    for (const settle of meterSettlements.splice(0)) { settle(); record('meter:released-after-response') }
    await Promise.resolve()
  }
  assert.equal(providerIndex, fixture.responses.length, `${fixture.id}: every planned response must be consumed`)
  assert.equal(timers.size, 0, `${fixture.id}: provider timers must be cleared`)
  assert.equal(responses.at(-1).status, fixture.expectedStatus)
  assert.equal(responses.at(-1).json.provider, fixture.expectedProvider)
  if (fixture.expectedProvider) assert.equal(meterCalls.length, turnBodies.length)
  else assert.equal(meterCalls.length, 0)
  if (!fixture.queryFailure && fixtureAuth?.sub && requests.length > 0) {
    assert.ok(requests[0].body.includes('Synthetic Lantern Studio'), `${fixture.id}: real persona must enter request`)
    assert.ok(requests[0].body.includes('find_entity'), `${fixture.id}: full tool catalog must enter request`)
    assert.ok(!requests[0].body.includes('FOREIGN_ORG_CANARY'), `${fixture.id}: foreign-org fixture must stay excluded`)
  }
  return { trace, requests, responses, meterCalls, toolCount: catalog.CRM_TOOLS.length }
}

function comparable(result, stripObservation) {
  return {
    ...result,
    meterCalls: result.meterCalls.map(call => {
      const copied = structuredClone(call)
      if (stripObservation && copied.args.metadata && Object.hasOwn(copied.args.metadata, 'scout_usage_observation')) {
        delete copied.args.metadata.scout_usage_observation
        if (Object.keys(copied.args.metadata).length === 0) delete copied.args.metadata
      }
      return copied
    }),
  }
}

function assertEquivalent(before, after) {
  assert.deepEqual(comparable(after, true), comparable(before, false))
}

const cases = []
const detailedCases = []
for (const fixture of fixtures) {
  const before = await runRoute('baseline', fixture)
  const after = await runRoute('candidate', fixture)
  assertEquivalent(before, after)
  const observations = after.meterCalls.map(call => call.args.metadata?.scout_usage_observation)
  for (const observation of observations) {
    assert.equal(observation?.scope, 'final_response_only')
    assert.equal(observation?.workflowCoverage, 'incomplete')
    assert.ok(!JSON.stringify(observation).includes('private-synthetic-usage-canary'))
  }
  cases.push({ id: fixture.id, pass: true, requestCount: after.requests.length, responseCount: after.responses.length, status: after.responses.at(-1).status, meterCallCount: after.meterCalls.length, traceSha256: hash(JSON.stringify(comparable(after, true))), observations })
  detailedCases.push({ id: fixture.id, fixture, before, after })
}

const toolFixture = { id: 'lookup-to-terminal-answer', responses: [gemini(lookupReply), gemini(terminalReply)], expectedStatus: 200, expectedProvider: 'gemini' }
const toolTurns = [baseBody, priorResponses => ({
  ...baseBody,
  messages: [
    ...baseBody.messages,
    { role: 'assistant', content: priorResponses[0].json.message },
    { role: 'user', content: '[TOOL RESULT] find_entity: One matching contact: Maria Chen, id=synthetic-contact-1, email=maria@example.test' },
  ],
})]
const beforeTool = await runRoute('baseline', toolFixture, toolTurns)
const afterTool = await runRoute('candidate', toolFixture, toolTurns)
assertEquivalent(beforeTool, afterTool)
assert.equal(afterTool.responses[0].json.message, lookupReply)
assert.equal(afterTool.responses[1].json.message, terminalReply)
assert.ok(afterTool.requests[1].body.includes('[TOOL RESULT]'))
cases.push({ id: toolFixture.id, pass: true, requestCount: 2, responseCount: 2, meterCallCount: 2, traceSha256: hash(JSON.stringify(comparable(afterTool, true))) })
detailedCases.push({ id: toolFixture.id, fixture: toolFixture, before: beforeTool, after: afterTool })

const witness = detailedCases.find(item => item.id === 'gemini-rich-context')
const mutations = {
  requestBody: value => { value.requests[0].body += ' ' },
  requestHeader: value => { value.requests[0].headers.push(['x-synthetic-unexpected', '1']) },
  requestCount: value => { value.requests.push(structuredClone(value.requests[0])) },
  responseText: value => { value.responses[0].json.message += ' changed'; value.responses[0].raw = JSON.stringify(value.responses[0].json) },
  responseStatus: value => { value.responses[0].status = 201 },
  responseHeader: value => { value.responses[0].headers.push(['x-synthetic-unexpected', '1']) },
  responseProvider: value => { value.responses[0].json.provider = 'openai' },
  legacyTokens: value => { value.meterCalls[0].args.tokensIn += 1 },
  legacyByoKey: value => { value.meterCalls[0].args.byoKey = true },
  billingCacheField: value => { value.meterCalls[0].args.cachedTokensIn = 1200 },
  otherMetadata: value => { value.meterCalls[0].args.metadata.unexpected = 1 },
  authTrace: value => { value.trace.find(event => event.kind === 'allowance').auth.orgId = 'synthetic-other-org' },
  queryTrace: value => { value.trace.find(event => event.kind === 'query').table = 'synthetic-other-table' },
  timeoutDuration: value => { value.trace.find(event => event.kind === 'timer:set').milliseconds = 60000 },
  parseOrder: value => { const index = value.trace.findIndex(event => event.kind === 'provider:json:start'); [value.trace[index - 1], value.trace[index]] = [value.trace[index], value.trace[index - 1]] },
  meterOrder: value => { const index = value.trace.findIndex(event => event.kind === 'meter:start'); [value.trace[index], value.trace[index + 1]] = [value.trace[index + 1], value.trace[index]] },
}
const negativeControls = Object.entries(mutations).map(([id, mutate]) => {
  const changed = structuredClone(witness.after)
  mutate(changed)
  assert.throws(() => assertEquivalent(witness.before, changed), assert.AssertionError, `Comparator failed to reject ${id}`)
  return { id, rejected: true }
})

const sourceHashes = Object.fromEntries(Object.entries(paths).map(([name, relative]) => [name, {
  path: relative,
  baselineSha256: baselineSources[name] === undefined ? null : hash(baselineSources[name]),
  candidateSha256: hash(candidateSources[name]),
}]))
for (const [name, relative] of Object.entries(paths)) {
  assert.equal(hash(readFileSync(path.join(root, relative))), sourceHashes[name].candidateSha256, `Candidate source changed during verification: ${relative}`)
}
const scriptSha256 = hash(readFileSync(fileURLToPath(import.meta.url)))
const details = JSON.stringify({ schemaVersion: 1, baselineCommit, sourceHashes, scriptSha256, cases: detailedCases }, null, 2) + '\n'
const detailsSha256 = hash(details)
const receipt = {
  schemaVersion: 1,
  status: 'pass',
  scope: 'offline-route-and-synthetic-replayed-output-compatibility',
  baselineCommit,
  baselineSource: 'git show of the pinned commit; never derived by removing candidate edits',
  candidateHead: git(['rev-parse', 'HEAD']).trim(),
  sourceHashes,
  scriptSha256,
  runtime: { node: process.version, typescript: ts.version, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  networkCalls: 0,
  paidProviderCalls: 0,
  realDatabaseCalls: 0,
  successfulComparisons: cases.length,
  providerRequestsPerVersion: cases.reduce((total, item) => total + item.requestCount, 0),
  syntheticResponsesPerVersion: cases.reduce((total, item) => total + item.responseCount, 0),
  toolCatalogCount: witness.after.toolCount,
  comparisons: ['request bytes, headers, URL, method and order', 'timer scheduling, abort and clear order relative to JSON parsing', 'complete HTTP response status, headers, bytes and JSON', 'auth, allowance, data query and decrypt traces', 'all meter arguments except exactly metadata.scout_usage_observation', 'lookup and final-answer route turns with replayed provider output'],
  preservedUntouchedSource: ['provider access', 'persona composer', 'full tool catalog', 'native meter', 'shared billing logger', 'final UI consumer'],
  negativeControls,
  cases,
  detailsFile: 'traces.json',
  detailsSha256,
  limitations: [
    'No browser or UI-rendering test: the mounted consumer source is unchanged, but the replayed lookup sequence is driven by this harness, not by executing React or real actions.',
    'No new model generation, quality grading, actual cache hit measurement, savings estimate, production baseline attestation or activation approval.',
    'Synthetic database/auth/encryption/allowance dependencies replace production services; exact traces prove preservation only for these fixtures, not existing tenant-isolation correctness.',
    'Meter is stubbed at the route boundary. Legacy arguments and native meter/logger source are unchanged; persisted cost/allowance equivalence requires the separate native meter tests.',
    'Usage observations describe the final response only. Failed/unusable attempts and entirely failed workflows remain unobserved, and absent usage is not evidence of zero cost.',
    'Virtual provider timeout traces and delayed-meter checks are not end-to-end latency benchmarking.',
    'This is a focused compatibility check, not the repository-wide CI/build/template review gate.',
  ],
}
const artifactId = hash(JSON.stringify({ sourceHashes, scriptSha256, detailsSha256 }))
const destination = path.join(artifactRoot, artifactId)
mkdirSync(destination, { recursive: true })
writeFileSync(path.join(destination, 'traces.json'), details)
writeFileSync(path.join(destination, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ status: receipt.status, baselineCommit, successfulComparisons: receipt.successfulComparisons, negativeControls: negativeControls.length, providerRequestsPerVersion: receipt.providerRequestsPerVersion, paidProviderCalls: 0, receipt: path.join(destination, 'receipt.json'), detailsSha256 }, null, 2))
