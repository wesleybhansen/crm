import { NextResponse } from 'next/server'

// Clean URL proxy: /f/{slug} → /api/landing_pages/funnels/public/{slug}
// This gives users a shareable URL like example.com/f/my-funnel instead of the long API path.
// The module API dispatcher registers routes under the module id
// (landing_pages); the old /api/funnels/public/{slug} target 404ed.
// Public: '/f/(.*)' is in isPublicPage in src/proxy.ts and the target route
// has no auth requirement.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const url = new URL(req.url)
  const queryString = url.search || ''
  const baseUrl = process.env.APP_URL || url.origin
  return NextResponse.redirect(`${baseUrl}/api/landing_pages/funnels/public/${encodeURIComponent(slug)}${queryString}`, 307)
}
