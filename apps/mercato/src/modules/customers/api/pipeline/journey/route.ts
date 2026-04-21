// ORM-SKIP: complex multi-table logic or public/webhook endpoint
export const metadata = { path: '/pipeline/journey', GET: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from '@open-mercato/shared/lib/encryption/toggles'
import { createKmsService } from '@open-mercato/shared/lib/encryption/kms'

const DEFAULT_JOURNEY_STAGES = ['Prospect', 'First Contact', 'Customer', 'Repeat', 'VIP']

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // Get pipeline stages from business profile, or use defaults
    const profile = await knex('business_profiles').where('organization_id', auth.orgId).first()
    let stageNames: string[] = DEFAULT_JOURNEY_STAGES

    if (profile?.pipeline_stages) {
      const parsed = typeof profile.pipeline_stages === 'string'
        ? JSON.parse(profile.pipeline_stages)
        : profile.pipeline_stages
      if (Array.isArray(parsed) && parsed.length >= 2) {
        stageNames = parsed.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean)
      }
    }

    // Get all non-deleted contacts for this org
    const rawContacts = await knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .select('id', 'display_name', 'primary_email', 'lifecycle_stage', 'created_at')

    // Decrypt display_name / primary_email when tenant encryption is on.
    // Raw knex selects return ciphertext; the ORM decrypts via subscriber.
    const encryptionService = isTenantDataEncryptionEnabled()
      ? new TenantDataEncryptionService(em as any, { kms: createKmsService() })
      : null
    const contacts = encryptionService
      ? await Promise.all(rawContacts.map(async (c: any) => {
          try {
            const decrypted = await encryptionService.decryptEntityPayload(
              'customers:customer_entity',
              { display_name: c.display_name, primary_email: c.primary_email },
              auth.tenantId, auth.orgId,
            )
            return { ...c, display_name: decrypted.display_name ?? c.display_name, primary_email: decrypted.primary_email ?? c.primary_email }
          } catch {
            return c
          }
        }))
      : rawContacts

    // Get engagement scores for these contacts
    const contactIds = contacts.map((c: any) => c.id)
    let scoresMap: Record<string, number> = {}
    if (contactIds.length > 0) {
      const scores = await knex('contact_engagement_scores')
        .whereIn('contact_id', contactIds)
        .select('contact_id', 'score')
      for (const s of scores) {
        scoresMap[s.contact_id] = s.score
      }
    }

    // Group contacts by lifecycle_stage
    const stages = stageNames.map(stageName => {
      const stageContacts = contacts
        .filter((c: any) => {
          const contactStage = c.lifecycle_stage || 'Prospect'
          return contactStage.toLowerCase() === stageName.toLowerCase()
        })
        .map((c: any) => ({
          id: c.id,
          displayName: c.display_name,
          primaryEmail: c.primary_email,
          engagementScore: scoresMap[c.id] || 0,
          createdAt: c.created_at,
        }))

      return {
        name: stageName,
        count: stageContacts.length,
        contacts: stageContacts,
      }
    })

    // Also collect contacts whose stage doesn't match any defined stage
    const knownStagesLower = new Set(stageNames.map(s => s.toLowerCase()))
    const unmatchedContacts = contacts.filter((c: any) => {
      const stage = (c.lifecycle_stage || 'prospect').toLowerCase()
      return !knownStagesLower.has(stage)
    })
    if (unmatchedContacts.length > 0) {
      // Put them in the first stage
      const firstStage = stages[0]
      if (firstStage) {
        for (const c of unmatchedContacts) {
          firstStage.contacts.push({
            id: c.id,
            displayName: c.display_name,
            primaryEmail: c.primary_email,
            engagementScore: scoresMap[c.id] || 0,
            createdAt: c.created_at,
          })
          firstStage.count++
        }
      }
    }

    return NextResponse.json({ ok: true, data: { stages } })
  } catch (error) {
    console.error('[pipeline.journey.GET]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load journey pipeline' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    const { contactId, stage } = body
    if (!contactId) {
      return NextResponse.json({ ok: false, error: 'contactId is required' }, { status: 400 })
    }
    // stage may be null/empty to remove the contact from the pipeline view
    // (clears lifecycle_stage) without deleting the contact itself.
    const normalizedStage: string | null = (stage === null || stage === '' || stage === undefined) ? null : String(stage)

    // Verify contact belongs to this org
    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!contact) {
      return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
    }

    const previousStage = contact.lifecycle_stage

    // Update lifecycle stage (null clears it — removes from pipeline view)
    await knex('customer_entities')
      .where('id', contactId)
      .update({ lifecycle_stage: normalizedStage, updated_at: new Date() })

    // Track engagement event for stage change
    await knex('engagement_events').insert({
      id: require('crypto').randomUUID(),
      contact_id: contactId,
      organization_id: auth.orgId,
      tenant_id: auth.tenantId,
      event_type: normalizedStage === null ? 'pipeline_remove' : 'stage_change',
      points: normalizedStage === null ? 0 : 5,
      metadata: JSON.stringify({ from: previousStage, to: normalizedStage }),
      created_at: new Date(),
    })

    // Update engagement score
    const existing = await knex('contact_engagement_scores')
      .where('contact_id', contactId)
      .first()

    if (existing) {
      await knex('contact_engagement_scores')
        .where('contact_id', contactId)
        .update({ score: existing.score + 5, last_activity_at: new Date(), updated_at: new Date() })
    } else {
      await knex('contact_engagement_scores').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        contact_id: contactId,
        score: 5,
        last_activity_at: new Date(),
        updated_at: new Date(),
      })
    }

    // Trigger automation rules for stage change
    try {
      const rules = await knex('automation_rules')
        .where('organization_id', auth.orgId)
        .where('trigger_type', 'stage_change')
        .where('is_active', true)

      for (const rule of rules) {
        const triggerConfig = typeof rule.trigger_config === 'string' ? JSON.parse(rule.trigger_config) : rule.trigger_config
        if (triggerConfig.stage === normalizedStage || !triggerConfig.stage) {
          // Log automation execution
          await knex('automation_rule_logs').insert({
            id: require('crypto').randomUUID(),
            rule_id: rule.id,
            contact_id: contactId,
            trigger_data: JSON.stringify({ previousStage, newStage: normalizedStage }),
            action_result: JSON.stringify({ triggered: true }),
            status: 'executed',
            created_at: new Date(),
          })
        }
      }
    } catch {
      // Non-blocking: automation execution failures should not break the stage move
    }

    return NextResponse.json({ ok: true, data: { previousStage, newStage: normalizedStage } })
  } catch (error) {
    console.error('[pipeline.journey.PUT]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update contact stage' }, { status: 500 })
  }
}
