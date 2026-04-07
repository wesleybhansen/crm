import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Serve the marketing landing page (apps/mercato/public/landing.html) at the
// root URL without changing the visible URL in the browser. This bypasses the
// Next.js page at apps/mercato/src/app/page.tsx for the home route only.
export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === '/') {
    return NextResponse.rewrite(new URL('/landing.html', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: '/',
}
