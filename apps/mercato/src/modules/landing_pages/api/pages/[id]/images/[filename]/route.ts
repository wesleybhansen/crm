export const metadata = {
  GET: { requireAuth: false },
}
export const openApi = { summary: '[filename]', methods: {} }

import { resolveLandingPageImageAccess } from '@/modules/landing_pages/services/landing-page-image-access'
import { checkLandingPageImageRateLimit } from '@/modules/landing_pages/services/landing-page-image-rate-limit'
import {
  LANDING_PAGE_IMAGE_ROOT,
  isGeneratedImageFilename,
  landingPageImageResponse,
  readLandingPageImage,
} from '@/modules/landing_pages/services/landing-page-image-storage'

type RouteContext = {
  params: Promise<{ id: string; filename: string }>
}

export async function GET(req: Request, context: RouteContext) {
  try {
    const { id: pageId, filename } = await context.params
    if (!isGeneratedImageFilename(filename)) return new Response('Not found', { status: 404 })
    const rateLimitError = await checkLandingPageImageRateLimit(req, pageId, filename)
    if (rateLimitError) return rateLimitError

    const access = await resolveLandingPageImageAccess({
      pageId,
      // This route is intentionally public and can serve only an asset that is
      // referenced by the currently published control page or active A/B arm.
      // Draft/editor reads use the feature-guarded collection route instead.
      authOrganizationId: null,
      allowPublishedPublic: true,
      publicFilename: filename,
    })
    if (!access) return new Response('Not found', { status: 404 })

    const asset = await readLandingPageImage({
      root: LANDING_PAGE_IMAGE_ROOT,
      organizationId: access.organizationId,
      pageId,
      filename,
    })
    return asset
      ? landingPageImageResponse(asset, filename)
      : new Response('Not found', { status: 404 })
  } catch {
    return new Response('Error', { status: 500 })
  }
}
