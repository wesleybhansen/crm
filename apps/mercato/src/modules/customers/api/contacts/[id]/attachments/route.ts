export const metadata = { path: '/contacts/[id]/attachments', GET: { requireAuth: true }, POST: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { randomUUID } from 'crypto'
import { writeFile, mkdir, unlink } from 'fs/promises'
import { join } from 'path'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id: contactId } = await params

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!contact) {
      return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
    }

    const attachments = await knex('contact_attachments')
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')

    return NextResponse.json({ ok: true, data: attachments })
  } catch (error) {
    console.error('[contacts.attachments.GET]', error)
    return NextResponse.json({ ok: false, error: 'Failed to fetch attachments' }, { status: 500 })
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id: contactId } = await params

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!contact) {
      return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
    }

    const formData = await req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ ok: false, error: 'No file provided' }, { status: 400 })
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ ok: false, error: 'File too large. Maximum size is 10MB.' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const attachmentId = randomUUID()
    const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const storedName = `${attachmentId}-${safeFilename}`

    const uploadDir = join(process.cwd(), 'uploads', 'attachments', auth.orgId, contactId)
    await mkdir(uploadDir, { recursive: true })
    await writeFile(join(uploadDir, storedName), buffer)

    const fileUrl = `/api/contacts/${contactId}/attachments/${attachmentId}/download`

    const [attachment] = await knex('contact_attachments')
      .insert({
        id: attachmentId,
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        contact_id: contactId,
        filename: file.name,
        file_url: fileUrl,
        file_size: file.size,
        mime_type: file.type || null,
        uploaded_by: auth.userId || null,
      })
      .returning('*')

    return NextResponse.json({ ok: true, data: attachment })
  } catch (error) {
    console.error('[contacts.attachments.POST]', error)
    return NextResponse.json({ ok: false, error: 'Failed to upload attachment' }, { status: 500 })
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id: contactId } = await params
  const url = new URL(req.url)
  const attachmentId = url.searchParams.get('attachmentId')

  if (!attachmentId) {
    return NextResponse.json({ ok: false, error: 'Missing attachmentId parameter' }, { status: 400 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const attachment = await knex('contact_attachments')
      .where('id', attachmentId)
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .first()

    if (!attachment) {
      return NextResponse.json({ ok: false, error: 'Attachment not found' }, { status: 404 })
    }

    // Delete file from disk
    const safeFilename = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const filePath = join(process.cwd(), 'uploads', 'attachments', auth.orgId, contactId, `${attachmentId}-${safeFilename}`)
    try {
      await unlink(filePath)
    } catch {
      // File may already be deleted from disk, continue with DB cleanup
    }

    await knex('contact_attachments')
      .where('id', attachmentId)
      .where('organization_id', auth.orgId)
      .del()

    return NextResponse.json({ ok: true, data: { id: attachmentId } })
  } catch (error) {
    console.error('[contacts.attachments.DELETE]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete attachment' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Contacts',
  summary: 'Contact file attachments',
  methods: {
    GET: {
      summary: 'List all file attachments for a contact',
      tags: ['Contacts'],
    },
    POST: {
      summary: 'Upload a file attachment to a contact',
      tags: ['Contacts'],
    },
    DELETE: {
      summary: 'Delete a file attachment from a contact',
      tags: ['Contacts'],
    },
  },
}
