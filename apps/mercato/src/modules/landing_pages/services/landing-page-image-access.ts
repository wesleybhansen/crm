import { queryOne } from '@/lib/db'
import { isGeneratedImageFilename, isUuid } from './landing-page-image-storage'

export type LandingPageImageAccess = {
  organizationId: string
  isPublished: boolean
}

export async function resolveLandingPageImageAccess(args: {
  pageId: string
  authOrganizationId: string | null
  allowPublishedPublic: boolean
  publicFilename?: string
}): Promise<LandingPageImageAccess | null> {
  if (!isUuid(args.pageId)) return null
  if (args.publicFilename !== undefined && !isGeneratedImageFilename(args.publicFilename)) return null

  const page = await queryOne(
    `SELECT lp.id, lp.organization_id, lp.status,
       CASE WHEN lp.status = 'published' AND $2::text IS NOT NULL THEN
         strpos(coalesce(lp.published_html, ''), '/api/landing_pages/pages/' || lp.id::text || '/images/' || $2::text) > 0
         OR strpos(coalesce(lp.published_html, ''), '/api/pages/' || lp.id::text || '/images/' || $2::text) > 0
         OR strpos(coalesce(lp.published_html, ''), '/api/landing_pages/pages/' || lp.id::text || '/images?file=' || $2::text) > 0
         OR strpos(coalesce(lp.published_html, ''), '/api/pages/' || lp.id::text || '/images?file=' || $2::text) > 0
       ELSE false END AS image_is_published
       FROM landing_pages lp
      WHERE lp.id = $1 AND lp.deleted_at IS NULL`,
    [args.pageId, args.publicFilename ?? null],
  ) as { organization_id?: unknown; status?: unknown; image_is_published?: unknown } | null
  if (!page || typeof page.organization_id !== 'string' || !isUuid(page.organization_id)) return null

  const isPublished = page.status === 'published'
  let isPublishedAsset = isPublished && page.image_is_published === true

  // A/B support is intentionally optional in this repository. Keep the base
  // page query independent of its manual DDL, and fail closed to the control
  // asset when the table/column is absent or indeterminate.
  if (
    args.allowPublishedPublic &&
    isPublished &&
    !isPublishedAsset &&
    args.publicFilename !== undefined
  ) {
    try {
      const activeVariant = await queryOne(
        `SELECT true AS image_is_published
           FROM landing_pages lp
           JOIN landing_page_variants variant
             ON variant.landing_page_id = lp.id
            AND variant.organization_id = lp.organization_id
            AND variant.tenant_id = lp.tenant_id
          WHERE lp.id = $1
            AND lp.deleted_at IS NULL
            AND lp.status = 'published'
            AND lp.ab_enabled = true
            AND variant.status = 'active'
            AND (
              strpos(coalesce(variant.published_html, ''), '/api/landing_pages/pages/' || lp.id::text || '/images/' || $2::text) > 0
              OR strpos(coalesce(variant.published_html, ''), '/api/pages/' || lp.id::text || '/images/' || $2::text) > 0
              OR strpos(coalesce(variant.published_html, ''), '/api/landing_pages/pages/' || lp.id::text || '/images?file=' || $2::text) > 0
              OR strpos(coalesce(variant.published_html, ''), '/api/pages/' || lp.id::text || '/images?file=' || $2::text) > 0
            )
          LIMIT 1`,
        [args.pageId, args.publicFilename],
      ) as { image_is_published?: unknown } | null
      isPublishedAsset = activeVariant?.image_is_published === true
    } catch {
      isPublishedAsset = false
    }
  }
  if (
    page.organization_id !== args.authOrganizationId &&
    !(args.allowPublishedPublic && isPublishedAsset)
  ) return null

  return { organizationId: page.organization_id, isPublished }
}
