// ORM-SKIP: AI generation/analysis — complex prompt construction, not CRUD
export const metadata = { path: '/ai/scan-website', POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { url } = body

    if (!url?.trim()) {
      return NextResponse.json({ ok: false, error: 'URL is required' }, { status: 400 })
    }

    // Normalize URL
    let targetUrl = url.trim()
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl

    // Fetch the website
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    let html: string
    try {
      const res = await fetch(targetUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRMBot/1.0)' },
      })
      html = await res.text()
    } catch {
      return NextResponse.json({ ok: false, error: 'Could not reach that website. Check the URL and try again.' }, { status: 400 })
    } finally {
      clearTimeout(timeout)
    }

    // Extract basic info without AI (fast)
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const metaDescMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
      || html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i)
    const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)
    const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)
    const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)

    // Extract colors from CSS
    const colorMatches = html.match(/#[0-9a-fA-F]{3,8}/g) || []
    const colorCounts: Record<string, number> = {}
    for (const c of colorMatches) {
      const normalized = c.toLowerCase()
      if (normalized === '#fff' || normalized === '#ffffff' || normalized === '#000' || normalized === '#000000'
        || normalized === '#333' || normalized === '#333333' || normalized === '#666' || normalized === '#999'
        || normalized === '#ccc' || normalized === '#eee' || normalized === '#f5f5f5' || normalized === '#fafafa') continue
      colorCounts[normalized] = (colorCounts[normalized] || 0) + 1
    }
    const sortedColors = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])
    const brandPrimary = sortedColors[0]?.[0] || '#3B82F6'
    const brandSecondary = sortedColors[1]?.[0] || '#1E40AF'

    // Extract social links
    const socialLinks: Record<string, string> = {}
    const socialPatterns = [
      { key: 'facebook', pattern: /href=["'](https?:\/\/(?:www\.)?facebook\.com\/[^"'\s]+)["']/i },
      { key: 'instagram', pattern: /href=["'](https?:\/\/(?:www\.)?instagram\.com\/[^"'\s]+)["']/i },
      { key: 'twitter', pattern: /href=["'](https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^"'\s]+)["']/i },
      { key: 'linkedin', pattern: /href=["'](https?:\/\/(?:www\.)?linkedin\.com\/[^"'\s]+)["']/i },
      { key: 'youtube', pattern: /href=["'](https?:\/\/(?:www\.)?youtube\.com\/[^"'\s]+)["']/i },
      { key: 'tiktok', pattern: /href=["'](https?:\/\/(?:www\.)?tiktok\.com\/[^"'\s]+)["']/i },
    ]
    for (const { key, pattern } of socialPatterns) {
      const match = html.match(pattern)
      if (match) socialLinks[key] = match[1]
    }

    // Strip HTML to text for AI analysis (limit to 3000 chars)
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 3000)

    // Send to Gemini for analysis
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) {
      return NextResponse.json({
        ok: true,
        data: {
          businessName: titleMatch?.[1]?.trim() || ogTitleMatch?.[1]?.trim() || '',
          businessDescription: metaDescMatch?.[1]?.trim() || ogDescMatch?.[1]?.trim() || '',
          brandColors: { primary: brandPrimary, secondary: brandSecondary, background: '#ffffff' },
          socialLinks,
          partial: true,
          note: 'AI not configured — extracted basic info only',
        },
      })
    }

    const prompt = `Analyze this website content and data. Return ONLY valid JSON with these fields:
{
  "businessName": "the business name",
  "businessType": "one of: consulting, coaching, ecommerce, saas, agency, freelance, local_business, education, health_wellness, real_estate, other",
  "businessDescription": "1-2 sentence description",
  "mainOffer": "their primary product or service",
  "idealClients": "who their target audience is",
  "detectedServices": ["array of services/products, max 10"],
  "suggestedPipelineStages": ["4-6 stage names appropriate for this business type"],
  "suggestedPipelineMode": "deals or journey",
  "testimonials": [{"quote": "...", "attribution": "..."}],
  "detectedTone": "one of: professional, casual, bold, elegant, playful"
}

Website title: ${titleMatch?.[1] || 'unknown'}
Meta description: ${metaDescMatch?.[1] || ogDescMatch?.[1] || 'none'}
Detected colors: ${sortedColors.slice(0, 5).map(c => c[0]).join(', ')}
Social links found: ${Object.keys(socialLinks).join(', ') || 'none'}

Website text content:
${textContent}`

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
        }),
      }
    )

    const geminiData = await geminiRes.json()
    const aiText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const jsonMatch = aiText.match(/\{[\s\S]*\}/)

    let aiResult: any = {}
    if (jsonMatch) {
      try { aiResult = JSON.parse(jsonMatch[0]) } catch { /* ignore parse errors */ }
    }

    return NextResponse.json({
      ok: true,
      data: {
        businessName: aiResult.businessName || titleMatch?.[1]?.trim() || '',
        businessType: aiResult.businessType || 'other',
        businessDescription: aiResult.businessDescription || metaDescMatch?.[1]?.trim() || '',
        mainOffer: aiResult.mainOffer || '',
        idealClients: aiResult.idealClients || '',
        brandColors: { primary: brandPrimary, secondary: brandSecondary, background: '#ffffff' },
        socialLinks,
        detectedServices: aiResult.detectedServices || [],
        suggestedPipelineStages: aiResult.suggestedPipelineStages || [],
        suggestedPipelineMode: aiResult.suggestedPipelineMode || 'deals',
        testimonials: aiResult.testimonials || [],
        detectedTone: aiResult.detectedTone || 'professional',
        ogImage: ogImageMatch?.[1] || null,
      },
    })
  } catch (error) {
    console.error('[ai.scan-website]', error)
    return NextResponse.json({ ok: false, error: 'Failed to scan website' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'AI', summary: 'Scan website',
  methods: { POST: { summary: 'Scan a website URL and extract business data', tags: ['AI'] } },
}
