const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const IMAGE_FILENAME_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(?:jpe?g|png|gif|webp)'
const RELATIVE_URL_PREFIX = '(^|["\\\'(<\\s=])'
const URL_BOUNDARY = '(?=[&#"\\\')<\\s]|$)'

const LEGACY_QUERY_IMAGE_URL = new RegExp(
  `${RELATIVE_URL_PREFIX}\\/api\\/(?:pages|landing_pages\\/pages)\\/(${UUID_PATTERN})\\/images\\?file=(${IMAGE_FILENAME_PATTERN})${URL_BOUNDARY}`,
  'gi',
)
const LEGACY_PATH_IMAGE_URL = new RegExp(
  `${RELATIVE_URL_PREFIX}\\/api\\/pages\\/(${UUID_PATTERN})\\/images\\/(${IMAGE_FILENAME_PATTERN})${URL_BOUNDARY}`,
  'gi',
)
const CURRENT_PATH_IMAGE_URL = new RegExp(
  `${RELATIVE_URL_PREFIX}\\/api\\/landing_pages\\/pages\\/(${UUID_PATTERN})\\/images\\/(${IMAGE_FILENAME_PATTERN})${URL_BOUNDARY}`,
  'gi',
)

/** Rewrite only CRM-relative, generated image URLs; third-party absolute URLs stay untouched. */
export function normalizeLegacyLandingPageImageUrls(html: string): string {
  return html
    .replace(LEGACY_QUERY_IMAGE_URL, '$1/api/landing_pages/pages/$2/images/$3')
    .replace(LEGACY_PATH_IMAGE_URL, '$1/api/landing_pages/pages/$2/images/$3')
}

/**
 * Editor previews use the feature-guarded image route, including for drafts.
 * Persisted/public HTML keeps the canonical publication-gated path.
 */
export function normalizeLandingPageImagePreviewUrls(html: string): string {
  return normalizeLegacyLandingPageImageUrls(html)
    .replace(CURRENT_PATH_IMAGE_URL, '$1/api/landing_pages/pages/$2/images?file=$3')
}
