import type { GeneratedSection, StyleTokens } from './types'

function esc(value: string | null | undefined): string {
  // AI output can leave optional fields out (a testimonial with no title, an
  // item with no description); render them empty instead of throwing.
  const str = value == null ? '' : String(value)
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function getHeadline(s: GeneratedSection): string {
  if (s.headlineVariants && s.selectedHeadline !== undefined) return s.headlineVariants[s.selectedHeadline] || s.headline || ''
  return s.headline || ''
}

function getCtaText(s: GeneratedSection): string {
  if (s.ctaVariants && s.selectedCta !== undefined) return s.ctaVariants[s.selectedCta] || s.ctaText || 'Get Started'
  return s.ctaText || 'Get Started'
}

function gridClass(count: number): string {
  if (count === 1) return ' lp-grid-1'
  if (count === 3) return ' lp-grid-3'
  if (count === 4) return ' lp-grid-4'
  return '' // default 2-col for 2, 5, 6+
}

const checkSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>'
const starSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
const lockSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>'
const chevronSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lp-faq-chevron"><path d="M6 9l6 6 6-6"/></svg>'
const downloadSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'

// ---------------------------------------------------------------------------
// Hero — rendered by page-assembler (needs form/image context)
// This is a stub that returns basic markup; the assembler overrides it.
// ---------------------------------------------------------------------------
function renderHero(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const sub = section.subtitle ? esc(section.subtitle) : ''
  const cta = esc(getCtaText(section))

  return `<section class="lp-hero">
  <div class="lp-wide">
    <div class="lp-hero-copy">
      <h1 class="reveal">${h}</h1>
      ${sub ? `<p class="lp-hero-sub reveal reveal-d1">${sub}</p>` : ''}
      <a href="#form" class="lp-btn reveal reveal-d2">${cta}</a>
    </div>
  </div>
</section>`
}

// Exported for page-assembler to build the hero with full context
export { esc as escapeHtml, getHeadline, getCtaText, downloadSvg, checkSvg }

// ---------------------------------------------------------------------------
// Pain Points — icon-accented cards
// ---------------------------------------------------------------------------
function renderPainPoints(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const items = section.items || []
  const cards = items.map((item, i) =>
    `<div class="lp-pp-card reveal reveal-d${Math.min(i + 1, 4)}">
      <h3>${esc(item.title)}</h3>
      <p>${esc(item.description)}</p>
    </div>`
  ).join('\n    ')

  return `<section class="lp-section lp-pp">
  <div class="lp-container">
    ${h ? `<div class="lp-section-header reveal"><h2>${h}</h2></div>` : ''}
    <div class="lp-pp-grid">${cards}</div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Features — numbered cards with decorative ordinals
// ---------------------------------------------------------------------------
function renderFeaturesBenefits(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const items = section.items || []
  const sub = '' // could extract from section data if available

  const cards = items.map((item, i) =>
    `<div class="lp-feat-card reveal reveal-d${Math.min(i + 1, 4)}">
      <div class="lp-feat-num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</div>
      <h3>${esc(item.title)}</h3>
      <p>${esc(item.description)}</p>
    </div>`
  ).join('\n    ')

  return `<section class="lp-section lp-features">
  <div class="lp-wide">
    <div class="lp-section-header reveal">
      <h2>${h}</h2>
      ${sub ? `<p>${esc(sub)}</p>` : ''}
    </div>
    <div class="lp-feat-grid${gridClass(items.length)}">${cards}</div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// How It Works — numbered steps with connector line
// ---------------------------------------------------------------------------
function renderHowItWorks(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const items = section.items || []

  const steps = items.map((item, i) =>
    `<div class="lp-step reveal reveal-d${Math.min(i + 1, 4)}">
      <div class="lp-step-num">${i + 1}</div>
      <h3>${esc(item.title)}</h3>
      <p>${esc(item.description)}</p>
    </div>`
  ).join('\n    ')

  return `<section class="lp-section lp-steps">
  <div class="lp-container">
    ${h ? `<div class="lp-section-header reveal"><h2>${h}</h2></div>` : ''}
    <div class="lp-step-grid">${steps}</div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Testimonials — centered single card with stars and avatar
// ---------------------------------------------------------------------------
function renderTestimonials(section: GeneratedSection): string {
  const items = section.items || []
  // Render first testimonial as a hero-style centered quote
  const first = items[0]
  if (!first) return ''
  const name = esc(first.title)
  const quote = esc(first.description)
  const parts = name.split(',')
  const displayName = parts[0].trim()
  const role = parts.slice(1).join(',').trim()
  const initials = displayName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase()

  return `<section class="lp-section lp-testimonial">
  <div class="lp-container">
    <div class="lp-testi-card reveal">
      <div class="lp-testi-stars">${starSvg}${starSvg}${starSvg}${starSvg}${starSvg}</div>
      <blockquote class="lp-testi-quote">&ldquo;${quote}&rdquo;</blockquote>
      <div class="lp-testi-author">
        <div class="lp-testi-avatar">${initials}</div>
        <div>
          <div class="lp-testi-name">${displayName}</div>
          ${role ? `<div class="lp-testi-role">${esc(role)}</div>` : ''}
        </div>
      </div>
    </div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Logo / Trust Bar
// ---------------------------------------------------------------------------
function renderLogoBar(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const items = section.items || []
  const badges = items.map(item => `<span class="lp-trust-badge">${esc(item.title)}</span>`).join('\n      ')

  return `<section class="lp-trust-bar">
  <div class="lp-container">
    ${h ? `<p class="lp-trust-label">${h}</p>` : ''}
    <div class="lp-trust-row">${badges}</div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Story / Narrative
// ---------------------------------------------------------------------------
function renderStoryNarrative(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const body = section.body || ''
  const paras = body.split('\n\n').map(p => {
    const t = esc(p.trim())
    return t ? `<p>${t}</p>` : ''
  }).filter(Boolean).join('\n    ')

  return `<section class="lp-section lp-story">
  <div class="lp-container lp-narrow">
    ${h ? `<div class="lp-section-header reveal"><h2>${h}</h2></div>` : ''}
    <div class="lp-story-body reveal reveal-d1">${paras}</div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Before / After
// ---------------------------------------------------------------------------
function renderBeforeAfter(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const before = esc(section.beforeText || '')
  const after = esc(section.afterText || '')

  return `<section class="lp-section lp-ba">
  <div class="lp-container">
    ${h ? `<div class="lp-section-header reveal"><h2>${h}</h2></div>` : ''}
    <div class="lp-ba-grid">
      <div class="lp-ba-card lp-ba-before reveal">
        <span class="lp-ba-label">Before</span>
        <p>${before}</p>
      </div>
      <div class="lp-ba-card lp-ba-after reveal reveal-d1">
        <span class="lp-ba-label">After</span>
        <p>${after}</p>
      </div>
    </div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Offer Breakdown
// ---------------------------------------------------------------------------
function renderOfferBreakdown(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const items = section.items || []
  const list = items.map((item, i) =>
    `<li class="reveal reveal-d${Math.min(i + 1, 4)}">
      <span class="lp-check">${checkSvg}</span>
      <div>
        <strong>${esc(item.title)}</strong>
        ${item.description ? `<p>${esc(item.description)}</p>` : ''}
      </div>
    </li>`
  ).join('\n    ')

  return `<section class="lp-section lp-offer">
  <div class="lp-container lp-narrow">
    ${h ? `<div class="lp-section-header reveal"><h2>${h}</h2></div>` : ''}
    <ul class="lp-offer-list">${list}</ul>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Pricing — full pricing card with included items and guarantee
// ---------------------------------------------------------------------------
function renderPricing(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const price = esc(section.price || '')
  const note = section.priceNote ? esc(section.priceNote) : ''
  const guarantee = section.guaranteeText ? esc(section.guaranteeText) : ''
  const cta = esc(getCtaText(section))

  const items = section.items || []
  const includedHtml = items.length > 0
    ? `<ul style="list-style:none;padding:0;margin:0 0 20px;text-align:left">${items.map((item, i) =>
        `<li class="reveal reveal-d${Math.min(i + 1, 4)}" style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;font-size:14px;color:var(--lp-text)">
          <span style="color:var(--lp-accent);flex-shrink:0;margin-top:2px">${checkSvg}</span>
          <span><strong>${esc(item.title)}</strong>${item.description ? ` — ${esc(item.description)}` : ''}</span>
        </li>`
      ).join('')}</ul>`
    : ''

  return `<section class="lp-section lp-pricing">
  <div class="lp-container">
    ${h ? `<div class="lp-section-header reveal"><h2>${h}</h2></div>` : ''}
    <div class="lp-price-card reveal reveal-d1">
      <div class="lp-price-amount">${price}</div>
      ${note ? `<p class="lp-price-note">${note}</p>` : ''}
      ${includedHtml ? `<div class="lp-price-divider"></div>${includedHtml}` : ''}
      <div class="lp-price-divider"></div>
      <a href="#form" class="lp-btn lp-price-btn">${cta}</a>
      ${guarantee ? `<div class="lp-price-guarantee">${lockSvg}<span>${guarantee}</span></div>` : ''}
    </div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------
function renderFaq(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const items = section.faqItems || []
  const acc = items.map((item, i) =>
    `<details class="lp-faq-item reveal reveal-d${Math.min(i + 1, 4)}">
      <summary>${esc(item.question)}${chevronSvg}</summary>
      <div class="lp-faq-a">${esc(item.answer)}</div>
    </details>`
  ).join('\n    ')

  return `<section class="lp-section lp-faq">
  <div class="lp-container lp-narrow">
    ${h ? `<div class="lp-section-header reveal"><h2>${h}</h2></div>` : ''}
    ${acc}
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// CTA Block — contained card with decorative elements
// ---------------------------------------------------------------------------
function renderCtaBlock(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const sub = section.subtitle ? esc(section.subtitle) : ''
  const cta = esc(getCtaText(section))

  return `<section class="lp-section lp-bottom-cta">
  <div class="lp-container">
    <div class="lp-cta-card reveal">
      <div class="lp-cta-orb lp-cta-orb-1"></div>
      <div class="lp-cta-orb lp-cta-orb-2"></div>
      <h2>${h}</h2>
      ${sub ? `<p class="lp-cta-sub">${sub}</p>` : ''}
      <a href="#form" class="lp-btn lp-cta-btn">${cta}</a>
    </div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Value Stack — pricing replacement with itemized value breakdown
// ---------------------------------------------------------------------------
function renderValueStack(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const valueItems = section.valueItems || []
  const totalValue = section.totalValue ? esc(section.totalValue) : ''
  const price = section.price ? esc(section.price) : ''
  const paymentPlan = section.paymentPlan ? esc(section.paymentPlan) : ''
  const guarantee = section.guaranteeText ? esc(section.guaranteeText) : ''
  const cta = esc(getCtaText(section))

  const items = valueItems.map((item, i) =>
    `<div class="lp-vs-item reveal reveal-d${Math.min(i + 1, 4)}">
      <div class="lp-vs-item-info">
        <div class="lp-vs-item-name">${esc(item.name)}</div>
        <div class="lp-vs-item-desc">${esc(item.description)}</div>
      </div>
      <div class="lp-vs-item-value">${esc(item.value)}</div>
    </div>`
  ).join('\n      ')

  return `<section class="lp-section lp-vs">
  <div class="lp-container">
    ${h ? `<div class="lp-section-header reveal"><h2>${h}</h2></div>` : ''}
    <div class="lp-vs-card reveal">
    ${items ? `<div class="lp-vs-items">${items}</div>` : ''}
    ${totalValue || price ? '<div class="lp-vs-divider"></div>' : ''}
    <div class="lp-vs-pricing">
      ${totalValue ? `<div class="lp-vs-total"><span class="lp-vs-total-label">Total Value</span><span class="lp-vs-total-amount">${totalValue}</span></div>` : ''}
      ${price ? `<div class="lp-vs-price"><span class="lp-vs-price-label">Your Investment</span><span class="lp-vs-price-amount">${price}</span></div>` : ''}
      ${paymentPlan ? `<p class="lp-vs-plan">${paymentPlan}</p>` : ''}
      <a href="#form" class="lp-btn lp-vs-cta">${cta}</a>
      ${guarantee ? `<div class="lp-vs-guarantee">${lockSvg}<span>${guarantee}</span></div>` : ''}
    </div>
    </div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Who It's For — qualification two-column section
// ---------------------------------------------------------------------------
const xSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

function renderWhoItsFor(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const forItems = section.forItems || []
  const notForItems = section.notForItems || []

  const yesList = forItems.map((item, i) =>
    `<li class="reveal reveal-d${Math.min(i + 1, 4)}"><span class="lp-wif-check">${checkSvg}</span><span>${esc(item)}</span></li>`
  ).join('\n        ')

  const noList = notForItems.map((item, i) =>
    `<li class="reveal reveal-d${Math.min(i + 1, 4)}"><span class="lp-wif-x">${xSvg}</span><span>${esc(item)}</span></li>`
  ).join('\n        ')

  return `<section class="lp-section lp-wif">
  <div class="lp-container">
    ${h ? `<div class="lp-section-header reveal"><h2>${h}</h2></div>` : ''}
    <div class="lp-wif-grid">
      <div class="lp-wif-col lp-wif-col-yes reveal">
        <h3>This is for you if...</h3>
        <ul class="lp-wif-list">${yesList}</ul>
      </div>
      <div class="lp-wif-col lp-wif-col-no reveal reveal-d1">
        <h3>This is NOT for you if...</h3>
        <ul class="lp-wif-list">${noList}</ul>
      </div>
    </div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Two Futures Close — emotional closing CTA with contrasting paths
// ---------------------------------------------------------------------------
function renderTwoFuturesClose(section: GeneratedSection): string {
  const h = esc(getHeadline(section))
  const inaction = section.inactionText ? esc(section.inactionText) : ''
  const action = section.actionText ? esc(section.actionText) : ''
  const cta = esc(getCtaText(section))
  const guarantee = section.guaranteeText ? esc(section.guaranteeText) : ''

  return `<section class="lp-section lp-tfc">
  <div class="lp-container">
    ${h ? `<div class="lp-section-header reveal"><h2>${h}</h2></div>` : ''}
    <div class="lp-tfc-paths">
      <div class="lp-tfc-path lp-tfc-path-a reveal">
        <h3>If you do nothing...</h3>
        <p>${inaction}</p>
      </div>
      <div class="lp-tfc-path lp-tfc-path-b reveal reveal-d1">
        <h3>If you act today...</h3>
        <p>${action}</p>
      </div>
    </div>
    <a href="#form" class="lp-btn reveal reveal-d2">${cta}</a>
    ${guarantee ? `<p class="lp-tfc-guarantee reveal reveal-d3">${lockSvg} ${guarantee}</p>` : ''}
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
const renderers: Record<string, (section: GeneratedSection) => string> = {
  'hero': renderHero,
  'pain-points': renderPainPoints,
  'features-benefits': renderFeaturesBenefits,
  'how-it-works': renderHowItWorks,
  'testimonials': renderTestimonials,
  'logo-bar': renderLogoBar,
  'story-narrative': renderStoryNarrative,
  'before-after': renderBeforeAfter,
  'offer-breakdown': renderOfferBreakdown,
  'pricing': renderPricing,
  'faq': renderFaq,
  'cta-block': renderCtaBlock,
  'value-stack': renderValueStack,
  'who-its-for': renderWhoItsFor,
  'two-futures-close': renderTwoFuturesClose,
}

function isSectionEmpty(section: GeneratedSection): boolean {
  const t = section.type
  if (t === 'hero' || t === 'cta-block' || t === 'two-futures-close') return false
  if (['pain-points','features-benefits','how-it-works','testimonials','logo-bar','offer-breakdown'].includes(t)) return (section.items || []).length === 0
  if (t === 'faq') return !section.faqItems || section.faqItems.length === 0
  if (t === 'story-narrative') return !section.body?.trim()
  if (t === 'before-after') return !section.beforeText?.trim() && !section.afterText?.trim()
  if (t === 'pricing') return !section.price?.trim()
  if (t === 'value-stack') return (section.valueItems || []).length === 0 && !section.price?.trim()
  if (t === 'who-its-for') return (section.forItems || []).length === 0 && (section.notForItems || []).length === 0
  return false
}

export function renderSection(section: GeneratedSection, index: number): string {
  if (isSectionEmpty(section)) return ''
  const renderer = renderers[section.type]
  if (!renderer) return ''
  return renderer(section)
}
