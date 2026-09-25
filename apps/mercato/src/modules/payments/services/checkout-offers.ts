// ORM-SKIP: checkout_offers, products, courses, landing_pages and stripe_connections are raw-knex tables
/**
 * Offers (checkout_offers): what a business's pages may sell through the
 * public checkout. Owners manage them (GET/POST/PUT /api/payments/offers);
 * the marketing app lists them with an org API key (GET /api/ext/offers).
 *
 * A buyer is only ever returned to one of the offer's success_url_hosts: the
 * platform pages host (PUBLIC_PAGES_HOST, default pages.noliai.com) and the
 * business's own custom domains. Hosts are exact names; Noli's own domains
 * other than the pages host are refused.
 */
import type { Knex } from 'knex'
import {
  isReservedHost,
  isUuid,
  itemMode,
  loadItem,
  normalizeHost,
  offerHosts,
  offerUpsellIds,
  platformPagesHosts,
  type CheckoutItem,
  type OfferRow,
} from './public-checkout'

export type Scope = { organizationId: string; tenantId: string }

export type OfferView = {
  id: string
  name: string | null
  active: boolean
  /** Active, and its product or course can be sold as configured. */
  sellable: boolean
  mode: string
  item: { kind: 'product' | 'course'; id: string; name: string; amount: number; currency: string; interval: string | null } | null
  successUrlHosts: string[]
  allowedUpsellOfferIds: string[]
  checkoutPath: string
  createdAt: string | null
  updatedAt: string | null
}

function iso(value: unknown): string | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export async function offerView(knex: Knex, offer: OfferRow & Record<string, any>): Promise<OfferView> {
  const kind = offer.course_id ? 'course' : 'product'
  const item: CheckoutItem | null = await loadItem(knex, offer, kind, offer.course_id || offer.product_id)
  return {
    id: offer.id,
    name: offer.name ?? item?.name ?? null,
    active: offer.active === true,
    sellable: offer.active === true && item !== null && itemMode(item) === offer.mode,
    mode: offer.mode,
    item: item
      ? { kind: item.kind, id: item.id, name: item.name, amount: item.unitAmount / 100, currency: item.currency, interval: item.recurring?.interval ?? null }
      : null,
    successUrlHosts: offerHosts(offer),
    allowedUpsellOfferIds: offerUpsellIds(offer),
    checkoutPath: `/api/payments/public/offers/${offer.id}/checkout`,
    createdAt: iso(offer.created_at),
    updatedAt: iso(offer.updated_at),
  }
}

export async function listOffers(knex: Knex, scope: Scope, opts: { activeOnly?: boolean } = {}): Promise<OfferView[]> {
  let query = knex('checkout_offers')
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
  if (opts.activeOnly) query = query.where('active', true)
  const rows = await query.orderBy('created_at', 'desc')
  const out: OfferView[] = []
  for (const row of rows) out.push(await offerView(knex, row))
  return out
}

/** Platform pages host(s) plus the custom domains the business's pages use. */
export async function defaultOfferHosts(knex: Knex, scope: Scope): Promise<string[]> {
  const hosts = new Set(platformPagesHosts())
  try {
    const rows = await knex('landing_pages')
      .where('organization_id', scope.organizationId)
      .whereNull('deleted_at')
      .whereNotNull('custom_domain')
      .select('custom_domain')
    for (const row of rows as Array<{ custom_domain?: string | null }>) {
      const host = normalizeHost(row.custom_domain)
      if (host && !isReservedHost(host)) hosts.add(host)
    }
  } catch {
    // No landing pages table yet: the platform host alone.
  }
  return [...hosts]
}

export type OfferInput = {
  name?: unknown
  productId?: unknown
  courseId?: unknown
  successUrlHosts?: unknown
  allowedUpsellOfferIds?: unknown
  active?: unknown
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string }

export function validateHosts(raw: unknown): Validated<string[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'successUrlHosts must be a list of host names' }
  if (raw.length > 20) return { ok: false, error: 'At most 20 hosts per offer' }
  const out = new Set<string>()
  for (const value of raw) {
    const host = normalizeHost(value)
    if (!host) return { ok: false, error: `"${String(value).slice(0, 80)}" is not a host name, like pages.yourbusiness.com` }
    if (isReservedHost(host)) return { ok: false, error: `${host} is not available. Use ${platformPagesHosts()[0]} or a domain you own.` }
    out.add(host)
  }
  return { ok: true, value: [...out] }
}

export async function validateUpsells(knex: Knex, scope: Scope, raw: unknown, selfId: string | null): Promise<Validated<string[]>> {
  if (!Array.isArray(raw)) return { ok: false, error: 'allowedUpsellOfferIds must be a list of offer ids' }
  const ids = [...new Set(raw.map(String))]
  if (ids.length > 20) return { ok: false, error: 'At most 20 upsell offers' }
  for (const id of ids) {
    if (!isUuid(id) || id === selfId) return { ok: false, error: 'An upsell offer id is not valid' }
    const found = await knex('checkout_offers')
      .where('id', id)
      .where('organization_id', scope.organizationId)
      .where('tenant_id', scope.tenantId)
      .first()
    if (!found) return { ok: false, error: 'An upsell offer does not belong to this business' }
  }
  return { ok: true, value: ids }
}

/** Resolve the product or course an offer sells; it must be the business's own. */
export async function resolveOfferItem(knex: Knex, scope: Scope, input: OfferInput): Promise<Validated<{ productId: string | null; courseId: string | null; item: CheckoutItem }>> {
  const hasProduct = input.productId !== undefined && input.productId !== null && input.productId !== ''
  const hasCourse = input.courseId !== undefined && input.courseId !== null && input.courseId !== ''
  if (hasProduct === hasCourse) return { ok: false, error: 'Choose one product or one course' }
  const owner = { organization_id: scope.organizationId, tenant_id: scope.tenantId }
  const item = hasProduct ? await loadItem(knex, owner, 'product', input.productId) : await loadItem(knex, owner, 'course', input.courseId)
  if (!item) return { ok: false, error: hasProduct ? 'Product not found, inactive, or without a price' : 'Course not found, unpublished, or free' }
  return { ok: true, value: { productId: hasProduct ? item.id : null, courseId: hasCourse ? item.id : null, item } }
}

export { itemMode }
