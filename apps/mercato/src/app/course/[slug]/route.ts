import { NextResponse } from 'next/server'

// Clean URL proxy: /course/{slug} → /api/courses/public/{slug}
// The course editor shares /course/{slug}; this makes that link resolve to the
// public course page, the same way /p/{slug} does for landing pages.
// Students reach their lessons at /course/{slug}/learn (a page, not this route).
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const url = new URL(req.url)
  const queryString = url.search || ''
  const baseUrl = process.env.APP_URL || url.origin
  return NextResponse.redirect(`${baseUrl}/api/courses/public/${encodeURIComponent(slug)}${queryString}`, 307)
}
