import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const VALID_PROVIDERS = ['resend', 'sendgrid', 'ses', 'mailgun'] as const

// GET: Return the org's ESP connection (hide API key)
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.sub || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const connection = await knex('esp_connections')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .select('id', 'provider', 'sending_domain', 'is_active', 'created_at')
      .first()

    return NextResponse.json({ ok: true, data: connection || null })
  } catch (error) {
    console.error('[email.esp.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed to get ESP connection' }, { status: 500 })
  }
}

// POST: Save ESP configuration
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { provider, apiKey, sendingDomain } = body

    if (!provider || !apiKey) {
      return NextResponse.json(
        { ok: false, error: 'Provider and API key are required' },
        { status: 400 },
      )
    }

    if (!VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json(
        { ok: false, error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` },
        { status: 400 },
      )
    }

    // Test the connection with a lightweight API call
    const testResult = await testEspConnection(provider, apiKey, sendingDomain)
    if (!testResult.ok) {
      return NextResponse.json(
        { ok: false, error: `ESP connection test failed: ${testResult.error}` },
        { status: 400 },
      )
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Deactivate any existing ESP connection for this org
    await knex('esp_connections')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .update({ is_active: false, updated_at: new Date() })

    // Insert new connection
    await knex('esp_connections').insert({
      id: require('crypto').randomUUID(),
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      created_by: auth.sub,
      provider,
      api_key: apiKey,
      sending_domain: sendingDomain || null,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.esp.save]', error)
    return NextResponse.json({ ok: false, error: 'Failed to save ESP configuration' }, { status: 500 })
  }
}

// DELETE: Remove ESP connection
export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const connectionId = url.searchParams.get('id')
  if (!connectionId) {
    return NextResponse.json({ ok: false, error: 'Connection id is required' }, { status: 400 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const deleted = await knex('esp_connections')
      .where('id', connectionId)
      .where('organization_id', auth.orgId)
      .update({ is_active: false, updated_at: new Date() })

    if (!deleted) {
      return NextResponse.json({ ok: false, error: 'Connection not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.esp.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to disconnect ESP' }, { status: 500 })
  }
}

/**
 * Test an ESP connection by making a lightweight API call to the provider.
 */
async function testEspConnection(
  provider: string,
  apiKey: string,
  sendingDomain?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (provider) {
      case 'resend': {
        const res = await fetch('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          return { ok: false, error: data?.message || `HTTP ${res.status}` }
        }
        return { ok: true }
      }

      case 'sendgrid': {
        const res = await fetch('https://api.sendgrid.com/v3/scopes', {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        if (!res.ok) {
          return { ok: false, error: `HTTP ${res.status} — check your API key` }
        }
        return { ok: true }
      }

      case 'mailgun': {
        if (!sendingDomain) {
          return { ok: false, error: 'Sending domain is required for Mailgun' }
        }
        const res = await fetch(`https://api.mailgun.net/v3/${sendingDomain}/stats/total?event=delivered&duration=1m`, {
          headers: { Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` },
        })
        if (!res.ok) {
          return { ok: false, error: `HTTP ${res.status} — check your API key and domain` }
        }
        return { ok: true }
      }

      case 'ses': {
        // For SES, we accept SMTP credentials — test via nodemailer verify
        // apiKey format: "ACCESS_KEY_ID:SECRET_ACCESS_KEY:REGION" or SMTP user:pass
        const parts = apiKey.split(':')
        if (parts.length < 2) {
          return { ok: false, error: 'SES credentials should be in format SMTP_USER:SMTP_PASS or ACCESS_KEY:SECRET:REGION' }
        }
        // Test SMTP connection for SES
        try {
          const region = parts[2] || 'us-east-1'
          const nodemailer = await import('nodemailer')
          const transporter = nodemailer.createTransport({
            host: `email-smtp.${region}.amazonaws.com`,
            port: 587,
            secure: false,
            auth: { user: parts[0], pass: parts[1] },
            connectionTimeout: 10000,
          })
          await transporter.verify()
          return { ok: true }
        } catch (sesErr) {
          const message = sesErr instanceof Error ? sesErr.message : 'SES connection failed'
          return { ok: false, error: message }
        }
      }

      default:
        return { ok: false, error: `Unknown provider: ${provider}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection test failed'
    return { ok: false, error: message }
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Email', summary: 'ESP (Email Service Provider) connection',
  methods: {
    GET: { summary: 'Get ESP connection for org', tags: ['Email'] },
    POST: { summary: 'Save ESP configuration', tags: ['Email'] },
    DELETE: { summary: 'Remove ESP connection', tags: ['Email'] },
  },
}
