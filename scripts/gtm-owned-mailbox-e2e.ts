import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { startEphemeralEnvironment } from '../packages/cli/src/lib/testing/integration'

type BrokerPhase =
  | 'ready'
  | 'running'
  | 'awaiting_reply'
  | 'passed'
  | 'failed'

type OwnedInputs = {
  senderEmail: string
  recipientEmail: string
  appPassword: string
}

const MAX_FORM_BYTES = 4_096
const BROKER_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const FINISHED_PAGE_GRACE_MS = 2 * 60 * 1000

let phase: BrokerPhase = 'ready'
let detail = 'The isolated environment is ready. Enter owned mailbox details to authorize one test message.'
let submitted = false
let closeBroker: (() => void) | null = null

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function statusLabel(): string {
  if (phase === 'ready') return 'Ready for owner confirmation'
  if (phase === 'running') return 'Preparing and sending the one authorized message'
  if (phase === 'awaiting_reply') return 'Message accepted — reply from the recipient inbox now'
  if (phase === 'passed') return 'Lifecycle verified'
  return 'Rehearsal stopped safely'
}

function page(): string {
  const form = phase === 'ready'
    ? `<form method="post" action="/authorize" autocomplete="off">
        <label>Gmail sender
          <input name="senderEmail" type="email" inputmode="email" placeholder="owned@gmail.com" required>
        </label>
        <label>Yahoo or Proton recipient
          <input name="recipientEmail" type="email" inputmode="email" placeholder="owned@proton.me" required>
        </label>
        <label>Gmail app password
          <input name="appPassword" type="password" autocomplete="new-password" minlength="16" maxlength="128" required>
        </label>
        <label class="confirm"><input name="confirmed" type="checkbox" value="yes" required>
          I authorize exactly one campaign email between these two inboxes and one reply ingestion.
        </label>
        <button type="submit">Authorize and send one test email</button>
        <p class="fine">The app password is held in memory and the disposable database only. It is never written to source, logs, screenshots, traces, or test artifacts.</p>
      </form>`
    : `<section class="status-card">
        <div class="spinner" aria-hidden="true"></div>
        <p>${escapeHtml(detail)}</p>
        ${phase === 'awaiting_reply'
          ? '<p><strong>Open the recipient inbox, reply normally to the test email, and keep this page open.</strong></p>'
          : ''}
        ${phase === 'passed' || phase === 'failed'
          ? '<p>You may close this tab. The disposable environment is being removed.</p>'
          : ''}
      </section>`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Cache-Control" content="no-store">
  <title>GTM owned-mailbox rehearsal</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f5f2; color: #172019; }
    main { width: min(620px, calc(100vw - 32px)); padding: 36px; border: 1px solid #d7ddd5; border-radius: 22px; background: #fff; box-shadow: 0 18px 50px rgba(31, 45, 35, .09); }
    .eyebrow { color: #55705e; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 10px 0 8px; font-size: clamp(26px, 5vw, 38px); line-height: 1.08; }
    .lede { margin: 0 0 26px; color: #536058; line-height: 1.55; }
    form { display: grid; gap: 16px; }
    label { display: grid; gap: 7px; font-size: 14px; font-weight: 650; }
    input { box-sizing: border-box; width: 100%; border: 1px solid #b9c5bc; border-radius: 11px; padding: 12px 13px; font: inherit; }
    input:focus { outline: 3px solid #c9ead5; border-color: #287a49; }
    .confirm { grid-template-columns: 20px 1fr; align-items: start; font-weight: 500; line-height: 1.45; }
    .confirm input { width: 18px; height: 18px; margin-top: 1px; }
    button { border: 0; border-radius: 12px; padding: 13px 18px; background: #175b36; color: white; font: inherit; font-weight: 750; cursor: pointer; }
    button:hover { background: #104a2b; }
    .fine { margin: 0; color: #6b756e; font-size: 12px; line-height: 1.5; }
    .status-card { border-radius: 14px; background: #eef6f0; padding: 20px; line-height: 1.55; }
    .spinner { width: 22px; height: 22px; border: 3px solid #bcd5c3; border-top-color: #175b36; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Disposable · loopback only · two-message ceiling</div>
    <h1>${escapeHtml(statusLabel())}</h1>
    <p class="lede">Production GTM stays dark. No sourcing provider, shared service, customer data, or deployment setting is used.</p>
    ${form}
  </main>
  ${phase === 'running' || phase === 'awaiting_reply'
    ? '<script>setTimeout(() => location.reload(), 2500)</script>'
    : ''}
</body>
</html>`
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  })
  response.end(html)
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_FORM_BYTES) throw new Error('form_too_large')
    chunks.push(buffer)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function validateInputs(form: URLSearchParams): OwnedInputs {
  if (form.get('confirmed') !== 'yes') throw new Error('confirmation_required')
  const senderEmail = (form.get('senderEmail') ?? '').trim().toLowerCase()
  const recipientEmail = (form.get('recipientEmail') ?? '').trim().toLowerCase()
  const appPassword = (form.get('appPassword') ?? '').replaceAll(' ', '')
  if (!/^[^\s@]+@(gmail|googlemail)\.com$/.test(senderEmail)) throw new Error('invalid_sender')
  if (!/^[^\s@]+@(yahoo\.com|proton\.me|protonmail\.com|pm\.me)$/.test(recipientEmail)) {
    throw new Error('invalid_recipient')
  }
  if (senderEmail === recipientEmail) throw new Error('same_mailbox')
  if (appPassword.length < 16 || appPassword.length > 128) throw new Error('invalid_app_password')
  return { senderEmail, recipientEmail, appPassword }
}

function redactor(input: OwnedInputs): (value: string) => string {
  const secrets = [input.senderEmail, input.recipientEmail, input.appPassword]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  return (value: string) => secrets.reduce(
    (clean, secret) => clean.replaceAll(secret, '[redacted-owned-input]'),
    value,
  )
}

async function runPlaywright(
  commandEnvironment: NodeJS.ProcessEnv,
  input: OwnedInputs,
): Promise<void> {
  const scrub = redactor(input)
  const args = [
    'playwright',
    'test',
    '--config',
    '.ai/qa/tests/playwright.config.ts',
    'apps/mercato/src/modules/gtm/__integration__/TC-GTM-002.spec.ts',
    '--workers=1',
    '--retries=0',
    '--reporter=line',
  ]
  const child = spawn(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', args, {
    cwd: process.cwd(),
    env: {
      ...commandEnvironment,
      OM_GTM_OWNED_MAILBOX_E2E_ENABLED: '1',
      OM_GTM_OWNED_SENDER_EMAIL: input.senderEmail,
      OM_GTM_OWNED_RECIPIENT_EMAIL: input.recipientEmail,
      OM_GTM_OWNED_GMAIL_APP_PASSWORD: input.appPassword,
      PW_CAPTURE_SCREENSHOTS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let diagnostic = ''
  const collect = (chunk: Buffer | string) => {
    const clean = scrub(String(chunk))
    diagnostic = `${diagnostic}${clean}`.slice(-12_000)
    if (clean.includes('::gtm-owned-e2e:send-accepted::')) {
      phase = 'awaiting_reply'
      detail = 'The Gmail sender accepted the outbound message. Reply normally from the owned Yahoo or Proton inbox.'
    }
    if (clean.includes('::gtm-owned-e2e:reply-correlated::')) {
      detail = 'The owned reply was correlated and the enrollment stopped atomically.'
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const [exitCode] = await once(child, 'close') as [number | null]
  input.appPassword = ''
  if (exitCode !== 0) {
    const safeTail = diagnostic
      .split('\n')
      .filter((line) => !line.includes('OM_GTM_OWNED_'))
      .slice(-20)
      .join('\n')
    if (safeTail) console.error(`[gtm-owned-mailbox] Redacted failure tail:\n${safeTail}`)
    throw new Error(`owned-mailbox rehearsal failed with exit code ${exitCode ?? 'unknown'}`)
  }
}

async function main(): Promise<void> {
  if (process.env.CI === 'true') throw new Error('R4 owned-mailbox rehearsal cannot run in CI')
  const environment = await startEphemeralEnvironment({
    verbose: false,
    captureScreenshots: false,
    logPrefix: 'gtm-owned-mailbox',
    forceRebuild: false,
    reuseExisting: false,
    environmentOverrides: {
      OM_DISABLE_EMAIL_DELIVERY: '0',
      OM_GTM_OWNED_MAILBOX_E2E_ENABLED: '1',
      GTM_EXECUTION_ENABLED: 'true',
      GTM_MAILBOX_INGESTION_ENABLED: 'false',
      GTM_UNSUBSCRIBE_KEYRING: JSON.stringify({ r4: 'r4-ephemeral-unsubscribe-key-20260820' }),
      GTM_UNSUBSCRIBE_ACTIVE_KEY_ID: 'r4',
      GTM_APIFY_ENABLED: 'false',
      GTM_LEADMAGIC_ENABLED: 'false',
      GTM_DATAFORSEO_ENABLED: 'false',
      GTM_BOUNCER_ENABLED: 'false',
      AUTO_SPAWN_WORKERS: 'false',
      AUTO_SPAWN_SCHEDULER: 'false',
    },
  })

  const server = createServer(async (request, response) => {
    const host = request.headers.host ?? '127.0.0.1'
    const url = new URL(request.url ?? '/', `http://${host}`)
    if (request.method === 'GET' && url.pathname === '/') {
      sendHtml(response, 200, page())
      return
    }
    if (request.method === 'POST' && url.pathname === '/authorize') {
      if (submitted || phase !== 'ready') {
        sendHtml(response, 409, page())
        return
      }
      try {
        const input = validateInputs(await readForm(request))
        submitted = true
        phase = 'running'
        detail = 'Building the exact one-recipient campaign and establishing a metadata-only Gmail inbox baseline.'
        // Redirect the form POST to the read-only status page. Reloading a
        // 202 response at /authorize can turn into a GET for that POST-only
        // path in some browsers and display a misleading "Not found" even
        // though the authorized run is active.
        response.writeHead(303, {
          Location: '/',
          'Cache-Control': 'no-store, max-age=0',
          'Referrer-Policy': 'no-referrer',
        })
        response.end()
        void runPlaywright(environment.commandEnvironment, input)
          .then(() => {
            phase = 'passed'
            detail = 'One outbound message and one reply completed the controlled lifecycle. No additional message can be sent.'
          })
          .catch((error) => {
            phase = 'failed'
            detail = error instanceof Error
              ? 'The rehearsal stopped without retrying. See the redacted terminal diagnostic.'
              : 'The rehearsal stopped without retrying.'
          })
          .finally(async () => {
            await environment.stop()
            setTimeout(() => closeBroker?.(), FINISHED_PAGE_GRACE_MS).unref()
          })
      } catch {
        detail = 'The form was rejected. Use an owned Gmail sender, an owned Yahoo or Proton recipient, and a Gmail app password.'
        sendHtml(response, 400, page())
      }
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to bind loopback broker')
  closeBroker = () => server.close()
  const brokerUrl = `http://127.0.0.1:${address.port}`
  console.log(`[gtm-owned-mailbox] Owner confirmation: ${brokerUrl}`)

  const idleTimer = setTimeout(async () => {
    if (!submitted) {
      phase = 'failed'
      detail = 'The owner confirmation window expired without sending any message.'
      await environment.stop()
      closeBroker?.()
    }
  }, BROKER_IDLE_TIMEOUT_MS)
  idleTimer.unref()

  const stop = async () => {
    clearTimeout(idleTimer)
    await environment.stop()
    closeBroker?.()
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
  await once(server, 'close')
  clearTimeout(idleTimer)
}

main().catch((error) => {
  console.error(`[gtm-owned-mailbox] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
