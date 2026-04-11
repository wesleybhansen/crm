export const metadata = { path: '/chat/scrape-website', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

// Common pages that typically contain useful business information
const COMMON_PATHS = [
  '/about', '/about-us', '/about-me',
  '/pricing', '/plans', '/packages',
  '/services', '/products', '/offerings',
  '/faq', '/faqs', '/frequently-asked-questions',
  '/contact', '/contact-us', '/get-in-touch',
  '/terms', '/terms-of-service', '/terms-and-conditions',
  '/privacy', '/privacy-policy',
  '/refund-policy', '/returns', '/shipping',
  '/blog', '/resources', '/articles',
  '/testimonials', '/reviews', '/case-studies',
  '/team', '/our-team', '/staff',
  '/careers', '/jobs',
  '/features', '/how-it-works',
  '/gallery', '/portfolio', '/work',
]

const MAX_PAGES = 15
const PAGE_TIMEOUT = 8000
const MAX_CHARS_PER_PAGE = 15000
const MAX_TOTAL_CHARS = 80000

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractInternalLinks(html: string, baseUrl: URL): string[] {
  const links: string[] = []
  const linkRegex = /href=["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null) {
    try {
      const href = match[1]
      if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue
      const resolved = new URL(href, baseUrl)
      if (resolved.hostname !== baseUrl.hostname) continue
      if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|mp3|css|js|ico|woff|woff2|ttf|eot)$/i.test(resolved.pathname)) continue
      const clean = resolved.origin + resolved.pathname
      if (!links.includes(clean)) links.push(clean)
    } catch { /* skip invalid URLs */ }
  }
  return links
}

async function fetchPage(url: string): Promise<{ html: string; text: string } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CRM-Bot/1.0; +https://example.com/bot)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(PAGE_TIMEOUT),
      redirect: 'follow',
    })
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return null
    const html = await response.text()
    const text = stripHtml(html)
    if (text.length < 50) return null
    return { html, text: text.substring(0, MAX_CHARS_PER_PAGE) }
  } catch {
    return null
  }
}

function labelForPath(pathname: string): string {
  const clean = pathname.replace(/^\//, '').replace(/[-_]/g, ' ').replace(/\//g, ' > ')
  if (!clean || clean === '/') return 'Homepage'
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { url } = await req.json()
    if (!url?.trim()) return NextResponse.json({ ok: false, error: 'URL required' }, { status: 400 })

    let parsedUrl: URL
    try {
      parsedUrl = new URL(url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`)
    } catch {
      return NextResponse.json({ ok: false, error: 'Invalid URL' }, { status: 400 })
    }

    // Phase 1: Fetch the main page
    const mainPage = await fetchPage(parsedUrl.toString())
    if (!mainPage) {
      return NextResponse.json({ ok: false, error: `Could not fetch ${parsedUrl.hostname}` }, { status: 400 })
    }

    const crawledPages: Array<{ url: string; label: string; text: string }> = [
      { url: parsedUrl.toString(), label: 'Homepage', text: mainPage.text },
    ]

    // Phase 2: Discover internal links from the main page
    const discoveredLinks = extractInternalLinks(mainPage.html, parsedUrl)

    // Phase 3: Build a priority list of URLs to crawl
    const urlsToCrawl: string[] = []

    // First: common business pages
    for (const path of COMMON_PATHS) {
      const candidate = `${parsedUrl.origin}${path}`
      if (!urlsToCrawl.includes(candidate) && candidate !== parsedUrl.toString()) {
        urlsToCrawl.push(candidate)
      }
    }

    // Then: discovered internal links (sorted by path depth — shallower first)
    const sortedDiscovered = discoveredLinks
      .filter((link) => !urlsToCrawl.includes(link) && link !== parsedUrl.toString())
      .sort((a, b) => {
        const depthA = new URL(a).pathname.split('/').filter(Boolean).length
        const depthB = new URL(b).pathname.split('/').filter(Boolean).length
        return depthA - depthB
      })
    urlsToCrawl.push(...sortedDiscovered)

    // Phase 4: Crawl pages in batches (parallel fetches, up to MAX_PAGES total)
    let totalChars = mainPage.text.length
    const batchSize = 5

    for (let i = 0; i < urlsToCrawl.length && crawledPages.length < MAX_PAGES; i += batchSize) {
      if (totalChars >= MAX_TOTAL_CHARS) break
      const batch = urlsToCrawl.slice(i, i + batchSize)
      const results = await Promise.allSettled(batch.map((u) => fetchPage(u)))

      for (let j = 0; j < results.length; j++) {
        if (crawledPages.length >= MAX_PAGES || totalChars >= MAX_TOTAL_CHARS) break
        const result = results[j]
        if (result.status === 'fulfilled' && result.value) {
          const pageUrl = new URL(batch[j])
          crawledPages.push({
            url: batch[j],
            label: labelForPath(pageUrl.pathname),
            text: result.value.text,
          })
          totalChars += result.value.text.length
        }
      }
    }

    // Phase 5: Build combined content for AI processing
    const combinedContent = crawledPages
      .map((p) => `=== ${p.label} (${p.url}) ===
${p.text}`)
      .join('\n\n')

    // Phase 6: Use AI to create a comprehensive knowledge base
    const aiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (aiKey && combinedContent.length > 200) {
      try {
        const prompt = `You are building a comprehensive knowledge base for a customer-facing AI chat bot.

I've crawled ${crawledPages.length} pages from ${parsedUrl.hostname}. Extract ALL useful business information and organize it into a detailed, structured knowledge base.

IMPORTANT: Be thorough and specific. Include exact details — don't summarize away important information. The chat bot needs this to answer real customer questions accurately.

Structure the knowledge base with these sections (include all that apply):

## Business Overview
- What the business does, who they serve, their mission/value proposition
- Location(s), service areas, years in business

## Products & Services
- Every product/service mentioned with descriptions and details
- Features, benefits, what's included
- Any packages, tiers, or bundles

## Pricing
- All pricing mentioned (exact numbers)
- Payment terms, billing frequency
- Discounts, promotions, free trials

## Plans & Packages
- Detailed breakdown of each plan/tier
- What's included in each, limits, differences between plans

## Process & How It Works
- Step-by-step process for working with the business
- Onboarding flow, delivery timelines
- What customers should expect

## Policies
- Refund/return policy (exact terms)
- Cancellation policy
- Shipping/delivery policy
- Privacy practices
- Terms of service highlights

## FAQ / Common Questions
- Every FAQ answer found
- Common objections and responses

## Contact Information
- All contact methods (phone, email, address, hours)
- Social media links
- Support channels

## Team & Company
- Key team members and their roles
- Company history, credentials, certifications

## Testimonials & Social Proof
- Customer quotes and reviews
- Case study highlights
- Statistics and achievements

## Blog/Resource Highlights
- Key topics covered
- Popular articles or guides

Only include sections where you found relevant information. Use bullet points for readability. Be specific — include exact numbers, names, and details.

Website content from ${crawledPages.length} pages:

${combinedContent.substring(0, 120000)}`

        const aiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${aiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 8000 },
            }),
          },
        )
        const aiData = await aiRes.json()
        const summary = aiData.candidates?.[0]?.content?.parts?.[0]?.text
        if (summary) {
          return NextResponse.json({
            ok: true,
            data: {
              url: parsedUrl.toString(),
              content: summary,
              pagesScraped: crawledPages.length,
              pageList: crawledPages.map((p) => ({ url: p.url, label: p.label })),
              rawLength: totalChars,
            },
          })
        }
      } catch {
        // AI failed, return combined raw text
      }
    }

    // Fallback: return raw combined text (truncated)
    const fallbackContent = crawledPages
      .map((p) => `--- ${p.label} ---
${p.text.substring(0, 2000)}`)
      .join('\n\n')
      .substring(0, 15000)

    return NextResponse.json({
      ok: true,
      data: {
        url: parsedUrl.toString(),
        content: fallbackContent + '\n[AI processing unavailable — raw content provided]',
        pagesScraped: crawledPages.length,
        pageList: crawledPages.map((p) => ({ url: p.url, label: p.label })),
        rawLength: totalChars,
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
