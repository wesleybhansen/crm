import * as fs from 'fs'
import * as path from 'path'

export interface SectionField {
  key: string
  type: 'text' | 'textarea' | 'image' | 'repeater' | 'link'
  label: string
  current: string
  selector?: string // CSS selector or position hint for renderer
  items?: Record<string, string>[] // for repeater fields
}

export interface TemplateSection {
  id: string
  name: string
  type: string // nav, hero, features, testimonials, cta, footer, etc.
  enabled: boolean
  fields: SectionField[]
  html: string // raw HTML of this section
}

export interface TemplateSchema {
  templateId: string
  templateName: string
  category: string
  sections: TemplateSection[]
  cssVariables: Record<string, string>
  fonts: string[]
}

import { TEMPLATES_DIR } from './paths'

/**
 * Parse a template's HTML into a structured section schema.
 * Uses HTML comments and semantic tags to identify sections,
 * then extracts editable content from each.
 */
export function parseTemplate(templateId: string): TemplateSchema {
  const htmlPath = path.join(TEMPLATES_DIR, templateId, 'index.html')
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Template not found: ${templateId}`)
  }

  const html = fs.readFileSync(htmlPath, 'utf-8')

  // Extract CSS variables
  const cssVariables = extractCssVariables(html)

  // Extract fonts
  const fonts = extractFonts(html)

  // Split into sections
  const sections = extractSections(html)

  // Format template name
  const parts = templateId.split('-')
  const twoWordCategories = ['lead-magnet', 'info-product', 'physical-product', 'thank-you', 'case-study']
  const prefix = parts.slice(0, 2).join('-')
  let category: string
  if (twoWordCategories.includes(prefix)) {
    category = prefix
  } else {
    category = parts[0]
  }

  return {
    templateId,
    templateName: templateId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    category,
    sections,
    cssVariables,
    fonts,
  }
}

function extractCssVariables(html: string): Record<string, string> {
  const vars: Record<string, string> = {}
  const rootMatch = html.match(/:root\s*\{([^}]+)\}/)
  if (rootMatch) {
    const declarations = rootMatch[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+)/gi)
    for (const m of declarations) {
      vars[`--${m[1]}`] = m[2].trim()
    }
  }
  return vars
}

function extractFonts(html: string): string[] {
  const fonts: string[] = []
  const fontMatches = html.matchAll(/family=([^&"]+)/g)
  for (const m of fontMatches) {
    const families = decodeURIComponent(m[1]).split('|')
    for (const f of families) {
      const name = f.split(':')[0].replace(/\+/g, ' ')
      if (name && !fonts.includes(name)) fonts.push(name)
    }
  }
  return fonts
}

function extractSections(html: string): TemplateSection[] {
  const sections: TemplateSection[] = []
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  if (!bodyMatch) return sections

  const body = bodyMatch[1]

  // Remove script tags for parsing
  const bodyNoScript = body.replace(/<script[\s\S]*?<\/script>/gi, '')

  // Split by HTML comments and top-level semantic tags
  // Strategy: find all top-level elements (nav, section, div, footer) with their preceding comments
  const sectionRegex = /(?:<!--\s*(.+?)\s*-->\s*)?((?:<(?:nav|section|div|header|footer|aside)[^>]*>[\s\S]*?<\/(?:nav|section|div|header|footer|aside)>))/gi

  let match
  let index = 0
  while ((match = sectionRegex.exec(bodyNoScript)) !== null) {
    const comment = match[1] || ''
    const sectionHtml = match[2]

    // Determine section type from comment, class, or tag
    const type = detectSectionType(comment, sectionHtml)
    const name = comment || formatSectionType(type)
    const id = `section-${index}`

    const fields = extractFields(sectionHtml, type)

    sections.push({
      id,
      name,
      type,
      enabled: true,
      fields,
      html: sectionHtml,
    })
    index++
  }

  return sections
}

function detectSectionType(comment: string, html: string): string {
  const c = comment.toLowerCase()
  const h = html.toLowerCase()

  // Check comment first
  if (c.includes('nav')) return 'nav'
  if (c.includes('hero')) return 'hero'
  if (c.includes('feature') || c.includes('what you get') || c.includes("what's inside")) return 'features'
  if (c.includes('testimonial') || c.includes('what people say') || c.includes('reviews')) return 'testimonials'
  if (c.includes('proof') || c.includes('social proof') || c.includes('logos') || c.includes('trust')) return 'social-proof'
  if (c.includes('cta') || c.includes('call to action') || c.includes('bottom cta')) return 'cta'
  if (c.includes('faq')) return 'faq'
  if (c.includes('pricing')) return 'pricing'
  if (c.includes('footer')) return 'footer'
  if (c.includes('about') || c.includes('who') || c.includes('speaker')) return 'about'
  if (c.includes('benefit') || c.includes('why') || c.includes('how')) return 'benefits'
  if (c.includes('stat') || c.includes('number') || c.includes('metric')) return 'stats'

  // Check HTML classes/content
  if (h.includes('class="nav') || h.includes('<nav')) return 'nav'
  if (h.includes('class="hero')) return 'hero'
  if (h.includes('class="feature') || h.includes('class="benefit')) return 'features'
  if (h.includes('class="testimonial') || h.includes('class="review')) return 'testimonials'
  if (h.includes('class="faq')) return 'faq'
  if (h.includes('class="pricing')) return 'pricing'
  if (h.includes('class="cta') || h.includes('class="bottom-cta')) return 'cta'
  if (h.includes('<footer') || h.includes('class="footer')) return 'footer'
  if (h.includes('class="proof') || h.includes('class="logo')) return 'social-proof'

  return 'content'
}

function formatSectionType(type: string): string {
  const names: Record<string, string> = {
    'nav': 'Navigation',
    'hero': 'Hero',
    'features': 'Features',
    'testimonials': 'Testimonials',
    'social-proof': 'Social Proof',
    'cta': 'Call to Action',
    'faq': 'FAQ',
    'pricing': 'Pricing',
    'footer': 'Footer',
    'about': 'About',
    'benefits': 'Benefits',
    'stats': 'Stats',
    'content': 'Content',
  }
  return names[type] || type.charAt(0).toUpperCase() + type.slice(1)
}

function extractFields(html: string, sectionType: string): SectionField[] {
  const fields: SectionField[] = []

  // Extract headings
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  if (h1Match) {
    fields.push({
      key: 'headline',
      type: 'text',
      label: 'Headline',
      current: stripTags(h1Match[1]).trim(),
    })
  }

  const h2Matches = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
  if (h2Matches.length > 0) {
    fields.push({
      key: 'title',
      type: 'text',
      label: sectionType === 'hero' ? 'Headline' : 'Section Title',
      current: stripTags(h2Matches[0][1]).trim(),
    })
  }

  // Extract paragraphs (direct children of section, not inside cards)
  const directParagraphs = html.match(/<p[^>]*class="[^"]*(?:sub|desc|lead|intro|hero-sub|cta-sub)[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
  if (directParagraphs) {
    fields.push({
      key: 'subtitle',
      type: 'textarea',
      label: 'Subtitle / Description',
      current: stripTags(directParagraphs[1]).trim(),
    })
  }

  // Extract repeating items (feature cards, testimonials, list items, etc.)
  if (sectionType === 'features' || sectionType === 'benefits') {
    const cards = extractRepeatingCards(html)
    if (cards.length > 0) {
      fields.push({
        key: 'items',
        type: 'repeater',
        label: 'Feature Items',
        current: '',
        items: cards,
      })
    }
  }

  if (sectionType === 'testimonials') {
    const testimonials = extractTestimonials(html)
    if (testimonials.length > 0) {
      fields.push({
        key: 'items',
        type: 'repeater',
        label: 'Testimonials',
        current: '',
        items: testimonials,
      })
    }
  }

  if (sectionType === 'social-proof') {
    const proofItems = extractProofItems(html)
    if (proofItems.length > 0) {
      fields.push({
        key: 'items',
        type: 'repeater',
        label: 'Proof Points',
        current: '',
        items: proofItems,
      })
    }
  }

  if (sectionType === 'faq') {
    const faqs = extractFaqItems(html)
    if (faqs.length > 0) {
      fields.push({
        key: 'items',
        type: 'repeater',
        label: 'FAQ Items',
        current: '',
        items: faqs,
      })
    }
  }

  // Extract buttons/CTAs
  const btnMatch = html.match(/<(?:button|a)[^>]*class="[^"]*(?:btn|cta|form-btn)[^"]*"[^>]*>([\s\S]*?)<\/(?:button|a)>/i)
  if (btnMatch) {
    fields.push({
      key: 'ctaText',
      type: 'text',
      label: 'Button Text',
      current: stripTags(btnMatch[1]).trim().replace(/&rarr;/g, '→'),
    })
  }

  // Extract stats
  if (sectionType === 'hero' || sectionType === 'stats') {
    const stats = extractStats(html)
    if (stats.length > 0) {
      fields.push({
        key: 'stats',
        type: 'repeater',
        label: 'Stats',
        current: '',
        items: stats,
      })
    }
  }

  // Extract form fields
  const formInputs = [...html.matchAll(/<input[^>]*type="([^"]*)"[^>]*(?:placeholder="([^"]*)")?[^>]*>/gi)]
  if (formInputs.length > 0) {
    const formFields = formInputs
      .filter(m => ['text', 'email', 'tel', 'phone'].includes(m[1]))
      .map(m => ({ type: m[1], placeholder: m[2] || '' }))
    if (formFields.length > 0) {
      fields.push({
        key: 'formFields',
        type: 'repeater',
        label: 'Form Fields',
        current: '',
        items: formFields,
      })
    }
  }

  // Nav brand name
  if (sectionType === 'nav') {
    const logoMatch = html.match(/<[^>]*class="[^"]*(?:nav-logo|logo|brand)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i)
    if (logoMatch) {
      fields.push({
        key: 'brandName',
        type: 'text',
        label: 'Brand Name',
        current: stripTags(logoMatch[1]).trim(),
      })
    }
  }

  return fields
}

function extractRepeatingCards(html: string): Record<string, string>[] {
  const cards: Record<string, string>[] = []

  // Try feature-card pattern
  const cardMatches = [...html.matchAll(/<div[^>]*class="[^"]*(?:feature-card|benefit-item|card|item|step)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*(?:feature-card|benefit-item|card|item|step)|<\/div>)/gi)]

  if (cardMatches.length === 0) {
    // Try list items
    const liMatches = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    for (const m of liMatches) {
      cards.push({ text: stripTags(m[1]).trim() })
    }
    return cards
  }

  for (const m of cardMatches) {
    const cardHtml = m[1]
    const h3 = cardHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
    const p = cardHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    const num = cardHtml.match(/<[^>]*class="[^"]*(?:number|num|step-num|feature-number)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i)
    cards.push({
      title: h3 ? stripTags(h3[1]).trim() : '',
      description: p ? stripTags(p[1]).trim() : '',
      ...(num ? { number: stripTags(num[1]).trim() } : {}),
    })
  }

  return cards
}

function extractTestimonials(html: string): Record<string, string>[] {
  const items: Record<string, string>[] = []
  const quoteMatch = html.match(/<[^>]*class="[^"]*(?:testimonial-text|quote|review-text)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i)
  const nameMatch = html.match(/<[^>]*class="[^"]*(?:testimonial-name|author-name|name)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i)
  const roleMatch = html.match(/<[^>]*class="[^"]*(?:testimonial-role|author-role|role|title)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i)

  if (quoteMatch) {
    items.push({
      quote: stripTags(quoteMatch[1]).trim().replace(/^[""]|[""]$/g, ''),
      name: nameMatch ? stripTags(nameMatch[1]).trim() : 'Name',
      role: roleMatch ? stripTags(roleMatch[1]).trim() : 'Role, Company',
    })
  }
  return items
}

function extractProofItems(html: string): Record<string, string>[] {
  const items: Record<string, string>[] = []
  const proofMatches = [...html.matchAll(/<[^>]*class="[^"]*proof-item[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi)]
  const seen = new Set<string>()
  for (const m of proofMatches) {
    const text = stripTags(m[1]).trim()
    if (text && !seen.has(text)) {
      seen.add(text)
      items.push({ text })
    }
  }
  return items
}

function extractFaqItems(html: string): Record<string, string>[] {
  const items: Record<string, string>[] = []
  const questionMatches = [...html.matchAll(/<[^>]*class="[^"]*(?:faq-question|question|accordion-header)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi)]
  const answerMatches = [...html.matchAll(/<[^>]*class="[^"]*(?:faq-answer|answer|accordion-body|accordion-content)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi)]

  for (let i = 0; i < questionMatches.length; i++) {
    items.push({
      question: stripTags(questionMatches[i][1]).trim(),
      answer: answerMatches[i] ? stripTags(answerMatches[i][1]).trim() : '',
    })
  }
  return items
}

function extractStats(html: string): Record<string, string>[] {
  const stats: Record<string, string>[] = []
  const valueMatches = [...html.matchAll(/<[^>]*class="[^"]*(?:stat-value|stat-number|hero-stat-value|number|metric-value)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi)]
  const labelMatches = [...html.matchAll(/<[^>]*class="[^"]*(?:stat-label|stat-name|hero-stat-label|label|metric-label)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi)]

  for (let i = 0; i < valueMatches.length; i++) {
    stats.push({
      value: stripTags(valueMatches[i][1]).trim(),
      label: labelMatches[i] ? stripTags(labelMatches[i][1]).trim() : '',
    })
  }
  return stats
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, (m) => {
    const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&rarr;': '→', '&mdash;': '—', '&ndash;': '–', '&middot;': '·' }
    return entities[m] || m
  })
}
