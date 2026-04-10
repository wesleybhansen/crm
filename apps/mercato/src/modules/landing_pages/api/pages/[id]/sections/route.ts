export const metadata = { GET: { requireAuth: true }, PUT: { requireAuth: true } }
export const openApi = { summary: 'sections', methods: {} }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query, queryOne } from '@/app/api/funnels/db'

// Robust HTML section parser — splits the page body into top-level blocks
function parseSections(html: string): Array<{ id: string; type: string; fields: Record<string, any>; html: string }> {
  const sections: Array<{ id: string; type: string; fields: Record<string, any>; html: string }> = []

  // Extract just the body content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  const bodyHtml = bodyMatch ? bodyMatch[1] : html

  // Remove script tags before parsing
  const cleanBody = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '')

  // Strategy: find top-level semantic blocks. Split on direct-child section/header/footer/nav/div
  // that represent major page sections. Use a simple depth-aware approach.
  const blockTags = ['section', 'header', 'footer', 'nav', 'main', 'article']
  const blocks: string[] = []

  // Find all top-level blocks by matching opening tags at rough body-level
  const tagRegex = new RegExp(`<(${blockTags.join('|')}|div)([^>]*)>`, 'gi')
  let lastEnd = 0
  let tagMatch

  // Simple approach: split on <!-- section --> comments or semantic tags
  // Many AI-generated pages use clear section breaks
  const commentSplit = cleanBody.split(/<!--\s*(?:section|SECTION)\s*-->/i)
  if (commentSplit.length > 2) {
    // Template uses comment-based sections
    commentSplit.filter(s => s.trim()).forEach((block, i) => blocks.push(block.trim()))
  } else {
    // Fall back to top-level semantic tags
    // Find each semantic tag and extract its full content (handling nesting)
    for (const tag of blockTags) {
      const openRegex = new RegExp(`<${tag}[^>]*>`, 'gi')
      let openMatch
      while ((openMatch = openRegex.exec(cleanBody)) !== null) {
        // Find the matching close tag, accounting for nesting
        let depth = 1
        let pos = openMatch.index + openMatch[0].length
        const closeTag = `</${tag}>`
        const openTag = `<${tag}`
        while (depth > 0 && pos < cleanBody.length) {
          const nextOpen = cleanBody.indexOf(openTag, pos)
          const nextClose = cleanBody.indexOf(closeTag, pos)
          if (nextClose === -1) break
          if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + openTag.length }
          else { depth--; pos = nextClose + closeTag.length }
        }
        if (depth === 0) {
          blocks.push(cleanBody.substring(openMatch.index, pos))
        }
      }
    }

    // If still no blocks, split on major <div> containers (class-based detection)
    if (blocks.length === 0) {
      const divRegex = /<div[^>]*class="[^"]*(?:section|container|wrapper|hero|feature|testimonial|cta|footer|faq|pricing)[^"]*"[^>]*>[\s\S]*?(?:<\/div>\s*){1,3}/gi
      let divMatch
      while ((divMatch = divRegex.exec(cleanBody)) !== null) {
        blocks.push(divMatch[0])
      }
    }

    // Final fallback: treat entire body as one section
    if (blocks.length === 0) {
      blocks.push(cleanBody)
    }
  }

  // Parse each block into a section
  blocks.forEach((block, i) => {
    const id = `section-${i}`
    const lower = block.toLowerCase()

    // Detect type
    let type = 'content'
    if (i === 0 && (lower.includes('<nav') || lower.includes('logo'))) type = 'nav'
    else if (lower.includes('<h1') && i <= 1) type = 'hero'
    else if (lower.includes('testimonial') || lower.includes('review') || lower.includes('quote')) type = 'testimonials'
    else if (lower.includes('feature') || lower.includes('benefit') || lower.includes('what you')) type = 'features'
    else if (lower.includes('faq') || lower.includes('frequently')) type = 'faq'
    else if (lower.includes('pricing') || lower.includes('plan')) type = 'pricing'
    else if (lower.includes('stat') || lower.includes('metric') || lower.includes('number')) type = 'stats'
    else if (lower.includes('<form')) type = 'form'
    else if (lower.includes('<footer') || (i === blocks.length - 1 && lower.includes('copyright'))) type = 'footer'
    else if (lower.includes('cta') || lower.includes('ready to') || lower.includes('get started')) type = 'cta'

    // Extract fields
    const fields: Record<string, any> = {}
    const h1 = block.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    const h3 = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
    const ps = block.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || []

    if (h1) fields.headline = h1[1].replace(/<[^>]+>/g, '').trim()
    else if (h2) fields.headline = h2[1].replace(/<[^>]+>/g, '').trim()
    if (h2 && h1) fields.subheadline = h2[1].replace(/<[^>]+>/g, '').trim()
    else if (h3) fields.subheadline = h3[1].replace(/<[^>]+>/g, '').trim()

    if (ps.length > 0) {
      const firstP = ps[0].replace(/<[^>]+>/g, '').trim()
      if (firstP.length > 10) fields.description = firstP
    }

    // Button
    const btn = block.match(/<(?:a|button)[^>]*(?:class="[^"]*(?:btn|button|cta)[^"]*"|type="submit")[^>]*>([\s\S]*?)<\/(?:a|button)>/i)
      || block.match(/<button[^>]*>([\s\S]*?)<\/button>/i)
    if (btn) fields.ctaText = btn[1].replace(/<[^>]+>/g, '').trim()

    const link = block.match(/<a[^>]*href="([^"]*)"[^>]*(?:class="[^"]*(?:btn|button|cta))/i)
    if (link) fields.ctaUrl = link[1]

    sections.push({ id, type, fields, html: block })
  })

  if (sections.length === 0) {
    sections.push({ id: 'section-0', type: 'content', fields: {}, html: cleanBody })
  }

  return sections
}

// GET: Extract sections from the page's current HTML
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id } = await params
    const page = await queryOne('SELECT * FROM landing_pages WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [id, auth.orgId])
    if (!page) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const config = typeof page.config === 'string' ? JSON.parse(page.config) : (page.config || {})

    // If sections already saved in config, return them
    if (config.sections && config.sections.length > 0) {
      return NextResponse.json({ ok: true, data: { sections: config.sections, wizardData: config.wizardData || config } })
    }

    // Otherwise parse from published HTML
    if (page.published_html) {
      const sections = parseSections(page.published_html)
      return NextResponse.json({ ok: true, data: { sections, wizardData: config.wizardData || config } })
    }

    // No HTML yet — return empty sections
    return NextResponse.json({ ok: true, data: { sections: [], wizardData: config.wizardData || config } })
  } catch (error) {
    console.error('[pages.sections.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// PUT: Save sections to config
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id } = await params
    const page = await queryOne('SELECT * FROM landing_pages WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [id, auth.orgId])
    if (!page) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const body = await req.json()
    const config = typeof page.config === 'string' ? JSON.parse(page.config) : (page.config || {})
    config.sections = body.sections || []

    await query('UPDATE landing_pages SET config = $1, updated_at = $2 WHERE id = $3', [JSON.stringify(config), new Date(), id])

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[pages.sections.put]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
