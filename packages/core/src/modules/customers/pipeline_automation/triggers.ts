import { z } from 'zod'
import type { Knex } from 'knex'

export type TriggerKey = 'form_submitted' | 'payment_captured' | 'sequence_completed' | 'engagement_threshold'
export type EntityType = 'deal' | 'person'
export type ActionType = 'set_stage' | 'advance_one' | 'set_lifecycle'

export type ResolvedTarget = {
  entityType: EntityType
  entityId: string
}

const formFiltersSchema = z.object({
  formIds: z.array(z.string().uuid()).optional(),
  isNewContactOnly: z.boolean().optional(),
})

const paymentFiltersSchema = z.object({
  gatewayProviders: z.array(z.string()).optional(),
  amountMin: z.number().optional(),
  amountMax: z.number().optional(),
})

const sequenceFiltersSchema = z.object({
  sequenceIds: z.array(z.string().uuid()).optional(),
})

const engagementFiltersSchema = z.object({
  scoreMin: z.number().int(),
  scoreMax: z.number().int().optional(),
})

export type TriggerDefinition = {
  key: TriggerKey
  eventId: string
  label: string
  description: string
  supportedEntities: EntityType[]
  filtersSchema: z.ZodTypeAny
  filterUiSchema: Array<{
    key: string
    label: string
    type: 'multi-select-form' | 'multi-select-gateway' | 'multi-select-sequence' | 'number' | 'boolean'
    required?: boolean
  }>
  matchesFilters: (filters: Record<string, any>, payload: Record<string, any>, ctx: { knex: Knex }) => Promise<boolean>
  resolveTargets: (
    payload: Record<string, any>,
    targetEntity: EntityType,
    ctx: { knex: Knex; organizationId: string; tenantId: string },
  ) => Promise<string | null>
}

async function findActiveDealForContact(
  knex: Knex,
  contactId: string,
  organizationId: string,
  tenantId: string,
): Promise<string | null> {
  // The deal<->person link table is customer_deal_people (deal_id +
  // person_entity_id, no org column — the outer query is org+tenant scoped).
  // This previously queried a nonexistent customer_deal_person_links table,
  // so every deal-targeted rule silently failed at resolve time.
  const deal = await knex('customer_deals')
    .where('organization_id', organizationId)
    .where('tenant_id', tenantId)
    .whereNull('deleted_at')
    .whereIn('id', function () {
      this.select('deal_id')
        .from('customer_deal_people')
        .where('person_entity_id', contactId)
    })
    .whereNotIn('status', ['won', 'win', 'lose', 'loose', 'lost'])
    .orderBy('updated_at', 'desc')
    .first('id')
  return deal?.id ?? null
}

export const TRIGGERS: TriggerDefinition[] = [
  {
    key: 'form_submitted',
    eventId: 'landing_pages.form.submitted',
    label: 'Form submitted',
    description: 'A landing-page or standalone form was submitted',
    supportedEntities: ['person'],
    filtersSchema: formFiltersSchema,
    filterUiSchema: [
      { key: 'formIds', label: 'Only these forms (leave empty for any form)', type: 'multi-select-form' },
      { key: 'isNewContactOnly', label: 'Only when the submission creates a new contact', type: 'boolean' },
    ],
    async matchesFilters(filters, payload) {
      const f = formFiltersSchema.parse(filters)
      if (f.isNewContactOnly && !payload.isNewContact) return false
      if (f.formIds && f.formIds.length > 0 && !f.formIds.includes(payload.formId)) return false
      return true
    },
    async resolveTargets(payload) {
      return payload.contactId ?? null
    },
  },
  {
    key: 'payment_captured',
    eventId: 'payment_gateways.payment.captured',
    label: 'Payment received',
    description: 'A payment was successfully captured',
    supportedEntities: ['person', 'deal'],
    filtersSchema: paymentFiltersSchema,
    filterUiSchema: [
      { key: 'gatewayProviders', label: 'Only these gateways (leave empty for any)', type: 'multi-select-gateway' },
      { key: 'amountMin', label: 'Minimum amount', type: 'number' },
      { key: 'amountMax', label: 'Maximum amount', type: 'number' },
    ],
    async matchesFilters(filters, payload, { knex }) {
      const f = paymentFiltersSchema.parse(filters)
      if (f.gatewayProviders && f.gatewayProviders.length > 0 && !f.gatewayProviders.includes(payload.providerKey)) {
        return false
      }
      if (f.amountMin !== undefined || f.amountMax !== undefined) {
        // Payload-first: the live Stripe webhook sends the amount inline.
        // Legacy gateway_transactions lookup kept for the old emitter.
        let amount = Number(payload.amount)
        if (!Number.isFinite(amount)) {
          const tx = await knex('gateway_transactions').where('id', payload.transactionId).first('amount')
          amount = Number(tx?.amount ?? 0)
        }
        if (f.amountMin !== undefined && amount < f.amountMin) return false
        if (f.amountMax !== undefined && amount > f.amountMax) return false
      }
      return true
    },
    async resolveTargets(payload, targetEntity, { knex, organizationId, tenantId }) {
      // Payload-first: the live Stripe webhook resolves the contact itself.
      let contactId: string | null = payload.contactId ?? null
      if (!contactId) {
        // Legacy path: gateway_transactions → payments → invoice → contact.
        const tx = await knex('gateway_transactions').where('id', payload.transactionId).first('payment_id')
        if (!tx?.payment_id) return null
        const payment = await knex('payments').where('id', tx.payment_id).first('contact_id', 'invoice_id')
          .catch(() => null)
        contactId = payment?.contact_id
          ?? (payment?.invoice_id
            ? (await knex('invoices').where('id', payment.invoice_id).first('contact_id'))?.contact_id
            : null)
      }
      if (!contactId) return null
      if (targetEntity === 'person') return contactId
      return findActiveDealForContact(knex, contactId, organizationId, tenantId)
    },
  },
  {
    key: 'sequence_completed',
    eventId: 'sequences.sequence.completed',
    label: 'Sequence completed',
    description: 'A contact finished a sequence',
    supportedEntities: ['person', 'deal'],
    filtersSchema: sequenceFiltersSchema,
    filterUiSchema: [
      { key: 'sequenceIds', label: 'Only these sequences (leave empty for any)', type: 'multi-select-sequence' },
    ],
    async matchesFilters(filters, payload) {
      const f = sequenceFiltersSchema.parse(filters)
      if (f.sequenceIds && f.sequenceIds.length > 0 && !f.sequenceIds.includes(payload.sequenceId)) return false
      return true
    },
    async resolveTargets(payload, targetEntity, { knex, organizationId, tenantId }) {
      const contactId = payload.contactId
      if (!contactId) return null
      if (targetEntity === 'person') return contactId
      return findActiveDealForContact(knex, contactId, organizationId, tenantId)
    },
  },
  {
    key: 'engagement_threshold',
    eventId: 'customers.engagement.score_updated',
    label: 'Engagement score crosses threshold',
    description: 'A contact’s engagement score crosses a configured threshold',
    supportedEntities: ['person'],
    filtersSchema: engagementFiltersSchema,
    filterUiSchema: [
      { key: 'scoreMin', label: 'Trigger when score reaches at least', type: 'number', required: true },
      { key: 'scoreMax', label: 'And does not exceed (optional)', type: 'number' },
    ],
    async matchesFilters(filters, payload) {
      const f = engagementFiltersSchema.parse(filters)
      const previousScore = Number(payload.previousScore ?? 0)
      const score = Number(payload.score ?? 0)
      // Crossed-up only: must have just risen above scoreMin (not already there).
      if (previousScore >= f.scoreMin) return false
      if (score < f.scoreMin) return false
      if (f.scoreMax !== undefined && score > f.scoreMax) return false
      return true
    },
    async resolveTargets(payload) {
      return payload.contactId ?? null
    },
  },
]

export const TRIGGERS_BY_KEY: Record<TriggerKey, TriggerDefinition> = TRIGGERS.reduce(
  (acc, t) => {
    acc[t.key] = t
    return acc
  },
  {} as Record<TriggerKey, TriggerDefinition>,
)

export const TRIGGERS_BY_EVENT_ID: Record<string, TriggerDefinition> = TRIGGERS.reduce(
  (acc, t) => {
    acc[t.eventId] = t
    return acc
  },
  {} as Record<string, TriggerDefinition>,
)
