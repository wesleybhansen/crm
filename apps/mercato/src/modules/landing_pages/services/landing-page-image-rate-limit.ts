import { getCachedRateLimiterService } from '@open-mercato/core/bootstrap'
import { checkRateLimit, getClientIp } from '@open-mercato/shared/lib/ratelimit/helpers'

const GLOBAL_IMAGE_BUDGET = {
  points: 1200,
  duration: 60,
  blockDuration: 60,
  keyPrefix: 'landing-page-images-public-ip',
}

const ASSET_IMAGE_BUDGET = {
  points: 60,
  duration: 60,
  blockDuration: 60,
  keyPrefix: 'landing-page-images-public-asset',
}

export async function checkLandingPageImageRateLimit(
  req: Request,
  pageId: string,
  filename: string,
): Promise<Response | null> {
  try {
    const service = getCachedRateLimiterService()
    if (!service) return null
    const clientIp = getClientIp(req, service.trustProxyDepth)
    if (!clientIp) return null

    const message = 'Too many image requests. Please try again later.'
    const globalError = await checkRateLimit(service, GLOBAL_IMAGE_BUDGET, clientIp, message)
    if (globalError) return globalError

    // A per-asset bucket keeps a large legitimate page from exhausting one
    // shared IP bucket while still bounding repeated disk reads for a target.
    return await checkRateLimit(
      service,
      ASSET_IMAGE_BUDGET,
      `${clientIp}:${pageId}:${filename}`,
      message,
    )
  } catch {
    return null
  }
}
