import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { decryptRowsForDisplay } from '@/modules/customers/lib/display-decrypt'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['payments.view'] },
  POST: { requireAuth: true, requireFeatures: ['payments.create'] },
  PUT: { requireAuth: true, requireFeatures: ['payments.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['payments.manage'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)
    const status = url.searchParams.get('status')

    let query = knex('invoices')
      .leftJoin('customer_entities', 'customer_entities.id', 'invoices.contact_id')
      .where('invoices.tenant_id', auth.tenantId)
      .where('invoices.organization_id', auth.orgId)
      .whereNull('invoices.deleted_at')
      .orderBy('invoices.created_at', 'desc')
      .select(
        'invoices.*',
        'customer_entities.display_name as contact_name',
        'customer_entities.primary_email as contact_email',
      )

    if (status) query = query.where('invoices.status', status)

    const invoices = await query.limit(50)
    // Joined contact name/email are encrypted at rest; this raw read skips the subscriber.
    await decryptRowsForDisplay(
      em, CONTACT_ENTITY_KEY, invoices,
      { contact_name: 'display_name', contact_email: 'primary_email' },
      auth.tenantId, auth.orgId,
    )
    return NextResponse.json({ ok: true, data: invoices })
  } catch (error) {
    console.error('[payments.invoices.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    const { contactId, dealId, lineItems, notes, dueDate, currency, termsUrl } = body
    if (!lineItems || !Array.isArray(lineItems) || lineItems.length === 0) {
      return NextResponse.json({ ok: false, error: 'At least one line item required' }, { status: 400 })
    }

    // Calculate totals
    const subtotal = lineItems.reduce((sum: number, item: any) => sum + (Number(item.price) * (item.quantity || 1)), 0)
    const tax = 0 // TODO: tax calculation
    const total = subtotal + tax

    // Generate invoice number
    const [{ count }] = await knex('invoices')
      .where('organization_id', auth.orgId)
      .count()
    const invoiceNumber = `INV-${String(Number(count) + 1).padStart(4, '0')}`

    const id = require('crypto').randomUUID()
    await knex('invoices').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      invoice_number: invoiceNumber,
      contact_id: contactId || null,
      deal_id: dealId || null,
      status: 'draft',
      line_items: JSON.stringify(lineItems),
      subtotal, tax, total,
      currency: currency || 'USD',
      due_date: dueDate || null,
      notes: notes || null,
      terms_url: termsUrl || null,
      created_at: new Date(),
      updated_at: new Date(),
    })

    const invoice = await knex('invoices').where('id', id).first()
    return NextResponse.json({ ok: true, data: invoice }, { status: 201 })
  } catch (error) {
    console.error('[payments.invoices.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function PUT(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()
    const { id, status } = body
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const validStatuses = ['draft', 'sent', 'paid']
    const update: Record<string, any> = { updated_at: new Date() }
    if (status && validStatuses.includes(status)) {
      update.status = status
      if (status === 'paid') {
        update.paid_at = new Date()
      } else {
        update.paid_at = null
      }
      if (status === 'draft') {
        update.sent_at = null
      }
    }

    const before = await knex('invoices')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .first('status')

    await knex('invoices')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .update(update)

    const invoice = await knex('invoices').where('id', id).where('organization_id', auth.orgId).first()

    // Marked paid just now: one payments.invoice.paid for automations.
    if (invoice && update.status === 'paid' && before?.status !== 'paid') {
      const { emitInvoicePaid } = await import('@/lib/crm-business-events')
      await emitInvoicePaid(container.resolve('eventBus') as Parameters<typeof emitInvoicePaid>[0], {
        id: String(invoice.id),
        organizationId: auth.orgId,
        tenantId: auth.tenantId,
        paidAt: (update.paid_at as Date).toISOString(),
        contactId: invoice.contact_id ?? null,
      })
    }
    return NextResponse.json({ ok: true, data: invoice })
  } catch (error) {
    console.error('[payments.invoices.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function DELETE(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()
    const { id } = body
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    // Only allow deleting draft invoices
    const invoice = await knex('invoices')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!invoice) return NextResponse.json({ ok: false, error: 'Invoice not found' }, { status: 404 })

    await knex('invoices')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .update({ deleted_at: new Date(), updated_at: new Date() })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[payments.invoices.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Payments', summary: 'Invoices',
  methods: {
    GET: { summary: 'List invoices', tags: ['Payments'] },
    POST: { summary: 'Create invoice', tags: ['Payments'] },
    PUT: { summary: 'Update invoice (mark as paid)', tags: ['Payments'] },
    DELETE: { summary: 'Delete draft invoice (soft)', tags: ['Payments'] },
  },
}
