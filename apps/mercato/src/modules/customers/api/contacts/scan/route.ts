import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function POST(req: Request) {
  await bootstrap()
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const aiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!aiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 400 })

  try {
    const formData = await req.formData()
    const file = formData.get('image') as File | null
    const defaultTags = formData.get('tags') as string || ''

    if (!file) return NextResponse.json({ ok: false, error: 'Image file required' }, { status: 400 })

    const buffer = await file.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')
    const mimeType = file.type || 'image/jpeg'

    const prompt = `You are extracting contact information from this image. It could be a business card, sign-in sheet, attendance list, handwritten notes, or any document containing people's contact details.

Extract ALL people/contacts visible. For each person, extract whatever is available:
- firstName, lastName
- email
- phone
- company (organization name)
- title (job title/role)
- website
- address
- notes (any other relevant info)

If a field is not visible or legible, use null. Do NOT skip any person — extract everyone.

Return ONLY a valid JSON array (no markdown, no explanation):
[{"firstName":"...","lastName":"...","email":"...","phone":"...","company":"...","title":"...","website":"...","address":"...","notes":"..."}]`

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${aiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: base64 } },
            ],
          }],
          generationConfig: { maxOutputTokens: 4000, temperature: 0.1 },
        }),
      },
    )

    const aiData = await res.json()
    let text = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()

    if (!text) return NextResponse.json({ ok: false, error: 'Could not extract information from image' }, { status: 400 })

    // Parse — could be single object or array
    let contacts: any[]
    if (text.startsWith('[')) {
      contacts = JSON.parse(text)
    } else {
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) return NextResponse.json({ ok: false, error: 'Could not parse extracted data' }, { status: 400 })
      contacts = [JSON.parse(match[0])]
    }

    // Return extracted data for review — saving is done via PUT
    return NextResponse.json({ ok: true, data: { contacts, count: contacts.length } })
  } catch (error) {
    console.error('[contacts.scan]', error)
    return NextResponse.json({ ok: false, error: 'Failed to process image' }, { status: 500 })
  }
}

// PUT: Save reviewed contacts
export async function PUT(req: Request) {
  await bootstrap()
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { contacts: contactsToSave, tags: defaultTags, lifecycleStage } = body
    if (!Array.isArray(contactsToSave) || contactsToSave.length === 0) {
      return NextResponse.json({ ok: false, error: 'No contacts to save' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const created: string[] = []
    let skipped = 0
    const tags = (defaultTags || '').split(',').map((t: string) => t.trim()).filter(Boolean)

    for (const c of contactsToSave) {
      try {
        const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
        if (!name && !c.email) continue

        // Skip duplicates by email
        if (c.email) {
          const existing = await knex('customer_entities')
            .where('organization_id', auth.orgId)
            .where('primary_email', c.email.toLowerCase())
            .whereNull('deleted_at')
            .first()
          if (existing) { skipped++; continue }
        }

        const id = require('crypto').randomUUID()

        // Insert entity
        await knex('customer_entities').insert({
          id, tenant_id: auth.tenantId, organization_id: auth.orgId,
          kind: 'person', display_name: name || 'Unknown',
          primary_email: c.email?.toLowerCase() || null, primary_phone: c.phone || null,
          source: 'photo-scan', status: 'active', is_active: true,
          lifecycle_stage: lifecycleStage || null,
          created_at: new Date(), updated_at: new Date(),
        })

        // Insert person profile (required for people list)
        await knex('customer_people').insert({
          id: require('crypto').randomUUID(),
          tenant_id: auth.tenantId, organization_id: auth.orgId, entity_id: id,
          first_name: c.firstName || name.split(' ')[0] || '',
          last_name: c.lastName || name.split(' ').slice(1).join(' ') || '',
          created_at: new Date(), updated_at: new Date(),
        }).catch(() => {})

        // Notes (title, company, website, address)
        const noteText = [c.title ? `Title: ${c.title}` : '', c.company ? `Company: ${c.company}` : '', c.website ? `Website: ${c.website}` : '', c.address ? `Address: ${c.address}` : '', c.notes || ''].filter(Boolean).join('\n')
        if (noteText) {
          await knex('contact_notes').insert({ id: require('crypto').randomUUID(), tenant_id: auth.tenantId, organization_id: auth.orgId, contact_id: id, content: noteText, created_at: new Date(), updated_at: new Date() }).catch(() => {})
        }

        // Tags
        for (const tagName of tags) {
          try {
            const slug = tagName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
            let tag = await knex('customer_tags').where('organization_id', auth.orgId).where('slug', slug).first()
            if (!tag) {
              const tagId = require('crypto').randomUUID()
              await knex('customer_tags').insert({ id: tagId, tenant_id: auth.tenantId, organization_id: auth.orgId, label: tagName, slug, color: ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6'][Math.floor(Math.random()*5)], created_at: new Date(), updated_at: new Date() })
              tag = { id: tagId }
            }
            const exists = await knex('customer_tag_assignments').where('entity_id', id).where('tag_id', tag.id).first()
            if (!exists) await knex('customer_tag_assignments').insert({ id: require('crypto').randomUUID(), entity_id: id, tag_id: tag.id, created_at: new Date() })
          } catch {}
        }

        created.push(id)
      } catch (err: any) {
        console.error('[contacts.scan] Failed to save contact:', err?.message)
      }
    }

    return NextResponse.json({ ok: true, data: { created: created.length, skipped, total: contactsToSave.length } })
  } catch (error: any) {
    console.error('[contacts.scan.save]', error?.message || error, error?.stack)
    return NextResponse.json({ ok: false, error: `Failed to save: ${error?.message || 'Unknown error'}` }, { status: 500 })
  }
}
