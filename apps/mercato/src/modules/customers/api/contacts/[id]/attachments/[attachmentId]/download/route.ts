
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readFile } from 'fs/promises'
import { join } from 'path'

export const metadata = { path: '/contacts/[id]/attachments/[attachmentId]/download',
  GET: { requireAuth: true },
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id: contactId, attachmentId } = await params

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

    const safeFilename = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const filePath = join(process.cwd(), 'uploads', 'attachments', auth.orgId, contactId, `${attachmentId}-${safeFilename}`)

    let fileBuffer: Buffer
    try {
      fileBuffer = await readFile(filePath)
    } catch {
      return NextResponse.json({ ok: false, error: 'File not found on disk' }, { status: 404 })
    }

    const contentType = attachment.mime_type || 'application/octet-stream'

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${attachment.filename}"`,
        'Content-Length': String(fileBuffer.length),
      },
    })
  } catch (error) {
    console.error('[contacts.attachments.download]', error)
    return NextResponse.json({ ok: false, error: 'Failed to download attachment' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Contacts',
  summary: 'Download a contact file attachment',
  methods: {
    GET: {
      summary: 'Download a specific file attachment',
      tags: ['Contacts'],
    },
  },
}
