export const metadata = { path: '/contacts/[id]/attachments', GET: { requireAuth: true }, POST: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CustomerEntity, CustomerContactAttachment } from '@open-mercato/core/modules/customers/data/entities'
import { randomUUID } from 'crypto'
import { writeFile, mkdir, unlink } from 'fs/promises'
import { join } from 'path'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id: contactId } = await params

  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const contact = await em.findOne(CustomerEntity, {
      id: contactId, organizationId: auth.orgId, tenantId: auth.tenantId, deletedAt: null,
    })
    if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })

    const attachments = await em.find(CustomerContactAttachment, {
      contactId, organizationId: auth.orgId, tenantId: auth.tenantId,
    }, { orderBy: { createdAt: 'desc' } })

    const data = attachments.map(a => ({
      id: a.id, contact_id: a.contactId, filename: a.filename,
      file_url: a.fileUrl, file_size: a.fileSize, mime_type: a.mimeType,
      uploaded_by: a.uploadedBy, created_at: a.createdAt,
    }))

    return NextResponse.json({ ok: true, data })
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
    const em = (container.resolve('em') as EntityManager).fork()

    const contact = await em.findOne(CustomerEntity, {
      id: contactId, organizationId: auth.orgId, tenantId: auth.tenantId, deletedAt: null,
    })
    if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return NextResponse.json({ ok: false, error: 'No file provided' }, { status: 400 })
    if (file.size > MAX_FILE_SIZE) return NextResponse.json({ ok: false, error: 'File too large. Maximum size is 10MB.' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const attachmentId = randomUUID()
    const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const storedName = `${attachmentId}-${safeFilename}`

    const uploadDir = join(process.cwd(), 'uploads', 'attachments', auth.orgId, contactId)
    await mkdir(uploadDir, { recursive: true })
    await writeFile(join(uploadDir, storedName), buffer)

    const fileUrl = `/api/contacts/${contactId}/attachments/${attachmentId}/download`

    const attachment = em.create(CustomerContactAttachment, {
      id: attachmentId,
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
      contactId,
      filename: file.name,
      fileUrl,
      fileSize: file.size,
      mimeType: file.type || null,
      uploadedBy: auth.userId || null,
    })
    em.persist(attachment)
    await em.flush()

    return NextResponse.json({ ok: true, data: {
      id: attachment.id, contact_id: attachment.contactId, filename: attachment.filename,
      file_url: attachment.fileUrl, file_size: attachment.fileSize, mime_type: attachment.mimeType,
      uploaded_by: attachment.uploadedBy, created_at: attachment.createdAt,
    } })
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
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id: contactId } = await params
  const url = new URL(req.url)
  const attachmentId = url.searchParams.get('attachmentId')
  if (!attachmentId) return NextResponse.json({ ok: false, error: 'Missing attachmentId parameter' }, { status: 400 })

  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const attachment = await em.findOne(CustomerContactAttachment, {
      id: attachmentId, contactId, organizationId: auth.orgId, tenantId: auth.tenantId,
    })
    if (!attachment) return NextResponse.json({ ok: false, error: 'Attachment not found' }, { status: 404 })

    // Delete file from disk
    const safeFilename = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const filePath = join(process.cwd(), 'uploads', 'attachments', auth.orgId, contactId, `${attachmentId}-${safeFilename}`)
    try { await unlink(filePath) } catch {}

    await em.removeAndFlush(attachment)

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
    GET: { summary: 'List all file attachments for a contact', tags: ['Contacts'] },
    POST: { summary: 'Upload a file attachment to a contact', tags: ['Contacts'] },
    DELETE: { summary: 'Delete a file attachment from a contact', tags: ['Contacts'] },
  },
}
