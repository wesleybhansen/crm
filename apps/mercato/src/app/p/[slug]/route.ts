import { NextResponse } from 'next/server'

// Clean URL proxy: /p/{slug} → /api/landing_pages/public/{slug}
// This gives users a shareable URL like example.com/p/my-page instead of /api/landing_pages/public/my-page
// Note: the module API dispatcher registers routes under the module id
// (landing_pages, underscore); the hyphenated path 404s.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const url = new URL(req.url)
  const queryString = url.search || ''
  const baseUrl = process.env.APP_URL || url.origin
  return NextResponse.redirect(`${baseUrl}/api/landing_pages/public/${encodeURIComponent(slug)}${queryString}`, 307)
}
