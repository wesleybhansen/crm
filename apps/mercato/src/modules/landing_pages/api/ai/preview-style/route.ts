export const metadata = { POST: { requireAuth: true } }
export const openApi = { summary: 'preview-style', methods: {} }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { assemblePage, assembleSimplePage } from '@/lib/landing-page-wizard/page-assembler'
import { getStyleById } from '@/lib/landing-page-wizard/styles'
import type { GeneratedSection } from '@/lib/landing-page-wizard/types'

interface PreviewRequest {
  sections: GeneratedSection[]
  styleId: string
  businessName?: string
  formFields?: { label: string; type: string; required: boolean }[]
  pageType?: string
  heroImageUrl?: string
  bookingPageSlug?: string
  productId?: string
  // Simple layout fields
  simpleLayout?: boolean
  simpleBullets?: string[]
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await req.json()) as PreviewRequest
    const { sections, styleId, businessName, formFields } = body

    if (!styleId) {
      return NextResponse.json({ ok: false, error: 'Missing styleId' }, { status: 400 })
    }

    const style = getStyleById(styleId)
    if (!style) {
      return NextResponse.json({ ok: false, error: `Unknown style: ${styleId}` }, { status: 400 })
    }

    let html: string

    if (body.simpleLayout) {
      // Simple centered layout: headline, subtitle, bullets, form
      const hero = sections?.[0]
      html = assembleSimplePage({
        style,
        pageTitle: businessName || 'Preview',
        headline: hero?.headline || 'Your Headline Here',
        subtitle: hero?.subtitle || '',
        bullets: body.simpleBullets || [],
        ctaText: hero?.ctaText || 'Get Started',
        formFields: formFields || [],
        formAction: '#',
        slug: 'preview',
        businessName,
      })
    } else {
      if (!sections) {
        return NextResponse.json({ ok: false, error: 'Missing sections' }, { status: 400 })
      }
      html = assemblePage({
        sections,
        style,
        pageTitle: businessName || 'Preview',
        formFields: formFields || [],
        formAction: '#',
        slug: 'preview',
        businessName,
        pageType: body.pageType || null,
        heroImageUrl: body.heroImageUrl || null,
        bookingPageSlug: body.bookingPageSlug || null,
        productId: body.productId || null,
      })
    }

    return NextResponse.json({ ok: true, html })
  } catch (err) {
    console.error('[preview-style] Error:', err)
    return NextResponse.json({ ok: false, error: 'Failed to generate preview' }, { status: 500 })
  }
}
