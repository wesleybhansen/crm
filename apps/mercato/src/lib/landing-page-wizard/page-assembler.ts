import type { GeneratedSection, StyleDefinition, PageType } from './types'
import { renderSection, escapeHtml as rEsc, getHeadline, getCtaText, downloadSvg, checkSvg } from './section-renderer'

export interface AssembleOptions {
  sections: GeneratedSection[]
  style: StyleDefinition
  pageTitle: string
  metaDescription?: string
  formFields: { label: string; type: string; required: boolean }[]
  formAction: string
  slug: string
  businessName?: string
  bookingPageSlug?: string | null
  productId?: string | null
  pageType?: string | null
  heroImageUrl?: string | null
  thankYouHeadline?: string | null
  thankYouMessage?: string | null
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function escJs(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function cssVars(style: StyleDefinition): string {
  const t = style.tokens
  return `:root {
    --lp-font-display: ${t.fontDisplay};
    --lp-font-body: ${t.fontBody};
    --lp-bg: ${t.colorBg};
    --lp-surface: ${t.colorSurface};
    --lp-text: ${t.colorText};
    --lp-text-muted: ${t.colorTextMuted};
    --lp-accent: ${t.colorAccent};
    --lp-accent-hover: ${t.colorAccentHover};
    --lp-cta: ${t.colorCta};
    --lp-cta-text: ${t.colorCtaText};
    --lp-border: ${t.colorBorder};
    --lp-radius: ${t.borderRadius};
    --lp-radius-lg: ${t.borderRadiusLg};
    --lp-container: ${t.containerMax};
    --lp-container-wide: 920px;
    --lp-headline-weight: ${t.headlineWeight};
    --lp-shadow: ${t.shadow};
    --lp-shadow-hover: ${t.shadowHover};
    --lp-transition: ${t.transition};
  }`
}

// ---------------------------------------------------------------------------
// The stylesheet — modelled directly on the reference template patterns
// ---------------------------------------------------------------------------
function baseCSS(): string {
  return `
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { font-family: var(--lp-font-body); color: var(--lp-text); background: var(--lp-bg); line-height: 1.6; font-size: 15px; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }

    /* subtle texture */
    body::before { content: ''; position: fixed; inset: 0; opacity: 0.15; pointer-events: none; z-index: 0;
      background-image: radial-gradient(circle, var(--lp-text-muted) 0.5px, transparent 0.5px);
      background-size: 32px 32px;
    }

    h1, h2, h3, h4 { font-family: var(--lp-font-display); color: var(--lp-text); line-height: 1.2; }
    img { max-width: 100%; height: auto; }
    a { color: var(--lp-accent); text-decoration: none; }
    a:hover { color: var(--lp-accent-hover); }

    /* Containers */
    .lp-container { max-width: var(--lp-container); margin: 0 auto; padding: 0 24px; position: relative; z-index: 1; }
    .lp-wide { max-width: var(--lp-container-wide); margin: 0 auto; padding: 0 24px; position: relative; z-index: 1; }
    .lp-narrow { max-width: 620px; }

    /* ============ NAV ============ */
    .lp-nav { position: relative; z-index: 10; background: var(--lp-bg); }
    .lp-nav-inner { max-width: var(--lp-container-wide); margin: 0 auto; padding: 0 24px; height: 64px; display: flex; align-items: center; justify-content: space-between; }
    .lp-nav-brand { font-family: var(--lp-font-display); font-size: 20px; font-weight: 700; color: var(--lp-text); text-decoration: none; }

    /* ============ HERO ============ */
    .lp-hero { padding: 48px 0 64px; position: relative; z-index: 1; }
    .lp-hero-grid { display: grid; grid-template-columns: 1fr; gap: 48px; align-items: start; }
    .lp-hero-2col { grid-template-columns: 1.1fr 0.9fr; align-items: center; }
    .lp-hero-copy { max-width: 580px; }
    .lp-hero-right { }
    .lp-hero-img { width: 100%; border-radius: var(--lp-radius-lg); box-shadow: 0 8px 32px rgba(0,0,0,0.1); }
    .lp-eyebrow { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; background: color-mix(in srgb, var(--lp-accent) 8%, transparent); border-radius: 999px; font-size: 13px; font-weight: 600; color: var(--lp-accent); margin-bottom: 20px; }
    .lp-eyebrow svg { width: 14px; height: 14px; }
    .lp-hero h1 { font-size: clamp(32px, 5vw, 46px); font-weight: 800; letter-spacing: -0.02em; margin-bottom: 16px; line-height: 1.1; }
    .lp-hero-sub { font-size: 16px; color: var(--lp-text-muted); line-height: 1.7; margin-bottom: 32px; max-width: 480px; }

    /* ============ BUTTONS ============ */
    .lp-btn { display: inline-block; padding: 16px 32px; background: var(--lp-cta); color: var(--lp-cta-text); font-family: var(--lp-font-body); font-size: 15px; font-weight: 600; border: none; border-radius: var(--lp-radius); cursor: pointer; transition: all var(--lp-transition); text-decoration: none; }
    .lp-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px color-mix(in srgb, var(--lp-cta) 25%, transparent); color: var(--lp-cta-text); }
    .lp-btn:active { transform: translateY(0); }

    /* ============ SECTION LAYOUT ============ */
    .lp-section { padding: 72px 0; position: relative; z-index: 1; }
    .lp-section + .lp-section { border-top: 1px solid var(--lp-border); }
    .lp-section-header { text-align: center; margin-bottom: 44px; }
    .lp-section-header h2 { font-size: clamp(26px, 4vw, 34px); font-weight: 800; letter-spacing: -0.02em; margin-bottom: 8px; }
    .lp-section-header p { font-size: 16px; color: var(--lp-text-muted); }

    /* ============ PAIN POINTS ============ */
    .lp-pp { background: var(--lp-surface); border-top: 1px solid var(--lp-border); border-bottom: 1px solid var(--lp-border); }
    .lp-pp-grid { display: flex; flex-direction: column; gap: 16px; max-width: 640px; margin: 0 auto; }
    .lp-pp-card { background: var(--lp-bg); border: 1px solid var(--lp-border); border-radius: var(--lp-radius-lg); padding: 28px 24px; transition: transform var(--lp-transition), box-shadow var(--lp-transition); position: relative; overflow: hidden; }
    .lp-pp-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--lp-accent); opacity: 0; transition: opacity var(--lp-transition); }
    .lp-pp-card:hover { transform: translateY(-2px); box-shadow: var(--lp-shadow-hover); }
    .lp-pp-card:hover::before { opacity: 1; }
    .lp-pp-icon { margin-bottom: 14px; color: var(--lp-accent); }
    .lp-pp-card h3 { font-size: 17px; font-weight: 700; margin-bottom: 8px; }
    .lp-pp-card p { font-size: 14px; color: var(--lp-text-muted); line-height: 1.6; }

    /* ============ FEATURES (NUMBERED CARDS) ============ */
    .lp-features { background: var(--lp-surface); border-top: 1px solid var(--lp-border); border-bottom: 1px solid var(--lp-border); }
    .lp-feat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
    .lp-feat-grid.lp-grid-3 { grid-template-columns: repeat(3, 1fr); }
    .lp-feat-grid.lp-grid-4 { grid-template-columns: repeat(2, 1fr); }
    .lp-feat-grid.lp-grid-1 { grid-template-columns: 1fr; max-width: 480px; margin: 0 auto; }
    .lp-feat-card { background: var(--lp-bg); border: 1px solid var(--lp-border); border-radius: var(--lp-radius-lg); padding: 28px 24px; transition: transform var(--lp-transition), box-shadow var(--lp-transition); }
    .lp-feat-card:hover { transform: translateY(-2px); box-shadow: var(--lp-shadow-hover); }
    .lp-feat-num { font-family: var(--lp-font-display); font-size: 36px; font-weight: 800; color: var(--lp-accent); opacity: 0.2; margin-bottom: 10px; line-height: 1; }
    .lp-feat-card h3 { font-size: 17px; font-weight: 700; margin-bottom: 8px; }
    .lp-feat-card p { font-size: 14px; color: var(--lp-text-muted); line-height: 1.6; }

    /* ============ HOW IT WORKS (STEPS) ============ */
    .lp-steps { }
    .lp-step-grid { display: flex; gap: 32px; justify-content: center; }
    .lp-step { flex: 1; max-width: 260px; text-align: center; }
    .lp-step-num { width: 52px; height: 52px; border-radius: 50%; background: var(--lp-accent); color: var(--lp-cta-text); display: flex; align-items: center; justify-content: center; font-family: var(--lp-font-display); font-weight: 700; font-size: 20px; margin: 0 auto 16px; }
    .lp-step h3 { font-size: 17px; font-weight: 700; margin-bottom: 8px; }
    .lp-step p { font-size: 14px; color: var(--lp-text-muted); line-height: 1.6; }

    /* ============ TESTIMONIAL ============ */
    .lp-testimonial { }
    .lp-testi-card { max-width: 580px; margin: 0 auto; text-align: center; }
    .lp-testi-stars { display: flex; justify-content: center; gap: 3px; margin-bottom: 20px; color: #F59E0B; }
    .lp-testi-quote { font-family: var(--lp-font-display); font-style: italic; font-size: clamp(18px, 2.5vw, 22px); line-height: 1.6; color: var(--lp-text); margin-bottom: 24px; font-weight: 400; border: none; padding: 0; }
    .lp-testi-author { display: flex; align-items: center; justify-content: center; gap: 12px; }
    .lp-testi-avatar { width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, var(--lp-accent), var(--lp-accent-hover)); display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; color: var(--lp-cta-text); flex-shrink: 0; }
    .lp-testi-name { font-size: 15px; font-weight: 600; color: var(--lp-text); text-align: left; }
    .lp-testi-role { font-size: 13px; color: var(--lp-text-muted); text-align: left; }

    /* ============ TRUST BAR ============ */
    .lp-trust-bar { padding: 20px 0; border-top: 1px solid var(--lp-border); border-bottom: 1px solid var(--lp-border); position: relative; z-index: 1; text-align: center; }
    .lp-trust-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--lp-text-muted); margin-bottom: 12px; font-weight: 500; }
    .lp-trust-row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
    .lp-trust-badge { padding: 6px 16px; background: var(--lp-surface); border: 1px solid var(--lp-border); border-radius: 999px; font-size: 12px; font-weight: 600; color: var(--lp-text-muted); white-space: nowrap; letter-spacing: 0.02em; }

    /* ============ STORY ============ */
    .lp-story-body p { margin-bottom: 1.5em; line-height: 1.8; font-size: 16px; color: var(--lp-text); }

    /* ============ BEFORE / AFTER ============ */
    .lp-ba-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 680px; margin: 0 auto; }
    .lp-ba-card { border-radius: var(--lp-radius-lg); padding: 32px 28px; }
    .lp-ba-before { background: var(--lp-surface); border: 1px solid var(--lp-border); }
    .lp-ba-after { background: var(--lp-accent); }
    .lp-ba-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; font-weight: 600; margin-bottom: 14px; }
    .lp-ba-before .lp-ba-label { color: var(--lp-text-muted); }
    .lp-ba-after .lp-ba-label { color: var(--lp-cta-text); opacity: 0.8; }
    .lp-ba-card p { line-height: 1.7; font-size: 15px; }
    .lp-ba-before p { color: var(--lp-text); }
    .lp-ba-after p { color: var(--lp-cta-text); }

    /* ============ OFFER BREAKDOWN ============ */
    .lp-offer-list { list-style: none; }
    .lp-offer-list li { display: flex; gap: 14px; align-items: flex-start; padding: 18px 0; border-bottom: 1px solid var(--lp-border); }
    .lp-check { color: var(--lp-accent); flex-shrink: 0; margin-top: 2px; }
    .lp-offer-list strong { font-weight: 600; font-size: 15px; display: block; color: var(--lp-text); }
    .lp-offer-list p { font-size: 14px; color: var(--lp-text-muted); line-height: 1.6; margin-top: 2px; }

    /* ============ PRICING ============ */
    .lp-pricing { text-align: center; }
    .lp-price-card { max-width: 400px; margin: 0 auto; padding: 40px 36px; background: var(--lp-surface); border: 1px solid var(--lp-border); border-radius: var(--lp-radius-lg); box-shadow: var(--lp-shadow); text-align: center; position: relative; overflow: hidden; }
    .lp-price-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--lp-accent); }
    .lp-price-amount { font-family: var(--lp-font-display); font-weight: 800; font-size: clamp(36px, 5vw, 48px); color: var(--lp-text); line-height: 1; letter-spacing: -0.02em; }
    .lp-price-note { color: var(--lp-text-muted); margin-top: 6px; font-size: 14px; }
    .lp-price-divider { width: 48px; height: 1px; background: var(--lp-border); margin: 24px auto; }
    .lp-price-btn { display: block; width: 100%; text-align: center; }
    .lp-price-guarantee { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 16px; font-size: 12px; color: var(--lp-text-muted); }

    /* ============ VALUE STACK ============ */
    .lp-vs { background: var(--lp-surface); border-top: 1px solid var(--lp-border); border-bottom: 1px solid var(--lp-border); }
    .lp-vs-card { max-width: 580px; margin: 0 auto; background: var(--lp-surface); border: 1px solid var(--lp-border); border-radius: var(--lp-radius-lg); padding: 40px 36px; box-shadow: var(--lp-shadow); position: relative; overflow: hidden; }
    .lp-vs-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--lp-accent); }
    .lp-vs-items { margin-bottom: 8px; }
    .lp-vs-item { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid color-mix(in srgb, var(--lp-border) 50%, transparent); }
    .lp-vs-item:last-child { border-bottom: none; }
    .lp-vs-item-info { flex: 1; }
    .lp-vs-item-name { font-family: var(--lp-font-display); font-weight: 600; font-size: 15px; color: var(--lp-text); margin-bottom: 2px; }
    .lp-vs-item-desc { font-size: 13px; color: var(--lp-text-muted); line-height: 1.5; }
    .lp-vs-item-value { font-size: 14px; font-weight: 600; color: var(--lp-text-muted); text-align: right; white-space: nowrap; }
    .lp-vs-divider { height: 2px; background: var(--lp-border); margin: 24px 0; }
    .lp-vs-total { text-align: center; margin-bottom: 12px; }
    .lp-vs-total-label { display: block; font-size: 12px; color: var(--lp-text-muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
    .lp-vs-total-amount { font-family: var(--lp-font-display); font-size: 22px; font-weight: 700; color: var(--lp-text-muted); text-decoration: line-through; }
    .lp-vs-price { text-align: center; margin-bottom: 24px; }
    .lp-vs-price-label { display: block; font-size: 12px; color: var(--lp-text-muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
    .lp-vs-price-amount { display: block; font-family: var(--lp-font-display); font-weight: 800; font-size: clamp(36px, 5vw, 48px); color: var(--lp-accent); line-height: 1.1; letter-spacing: -0.02em; }
    .lp-vs-pricing { text-align: center; }
    .lp-vs-plan { font-size: 14px; color: var(--lp-text-muted); margin-top: -16px; margin-bottom: 24px; }
    .lp-vs-cta { display: block; width: 100%; text-align: center; }
    .lp-vs-guarantee { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 16px; font-size: 12px; color: var(--lp-text-muted); text-align: center; }

    /* ============ WHO IT'S FOR ============ */
    .lp-wif-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; max-width: 720px; margin: 0 auto; }
    .lp-wif-col { padding: 28px 24px; border-radius: var(--lp-radius-lg); border: 1px solid var(--lp-border); }
    .lp-wif-col-yes { background: var(--lp-surface); }
    .lp-wif-col-no { background: var(--lp-bg); }
    .lp-wif-col h3 { font-size: 15px; font-weight: 700; margin-bottom: 16px; }
    .lp-wif-col-yes h3 { color: var(--lp-accent); }
    .lp-wif-col-no h3 { color: var(--lp-text-muted); }
    .lp-wif-list { list-style: none; }
    .lp-wif-list li { display: flex; align-items: flex-start; gap: 10px; padding: 7px 0; font-size: 14px; line-height: 1.5; color: var(--lp-text); }
    .lp-wif-check, .lp-wif-x { display: flex; flex-shrink: 0; margin-top: 2px; }
    .lp-wif-check { color: var(--lp-accent); }
    .lp-wif-x { color: var(--lp-text-muted); opacity: 0.5; }

    /* ============ TWO FUTURES CLOSE ============ */
    .lp-tfc { background: var(--lp-surface); border-top: 1px solid var(--lp-border); text-align: center; }
    .lp-tfc-paths { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 680px; margin: 0 auto 32px; }
    .lp-tfc-path { padding: 28px 24px; border-radius: var(--lp-radius-lg); text-align: left; }
    .lp-tfc-path h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; }
    .lp-tfc-path-a { background: var(--lp-bg); border: 1px solid var(--lp-border); }
    .lp-tfc-path-a h3 { color: var(--lp-text-muted); }
    .lp-tfc-path-b { background: var(--lp-accent); }
    .lp-tfc-path-b h3 { color: var(--lp-cta-text); opacity: 0.8; }
    .lp-tfc-path-a p { color: var(--lp-text-muted); font-size: 14px; line-height: 1.7; }
    .lp-tfc-path-b p { color: var(--lp-cta-text); font-size: 14px; line-height: 1.7; }
    .lp-tfc-guarantee { font-size: 13px; color: var(--lp-text-muted); margin-top: 16px; }

    /* ============ FAQ ============ */
    .lp-faq-item { border-bottom: 1px solid var(--lp-border); }
    .lp-faq-item summary { padding: 20px 0; cursor: pointer; font-weight: 600; color: var(--lp-text); font-size: 15px; list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 16px; line-height: 1.4; }
    .lp-faq-item summary::-webkit-details-marker { display: none; }
    .lp-faq-chevron { flex-shrink: 0; transition: transform 0.3s; color: var(--lp-text-muted); }
    .lp-faq-item[open] .lp-faq-chevron { transform: rotate(180deg); }
    .lp-faq-a { padding: 0 0 20px; color: var(--lp-text-muted); line-height: 1.7; font-size: 14px; }

    /* ============ BOTTOM CTA ============ */
    .lp-bottom-cta { padding: 32px 0 80px; }
    .lp-cta-card { max-width: 600px; margin: 0 auto; background: var(--lp-cta); border-radius: var(--lp-radius-lg); padding: 48px 40px; text-align: center; position: relative; overflow: hidden; }
    .lp-cta-orb { position: absolute; border-radius: 50%; }
    .lp-cta-orb-1 { top: -40px; right: -40px; width: 160px; height: 160px; background: rgba(255,255,255,0.06); }
    .lp-cta-orb-2 { bottom: -60px; left: -30px; width: 200px; height: 200px; background: rgba(255,255,255,0.04); }
    .lp-cta-card h2 { color: var(--lp-cta-text); font-size: clamp(24px, 3.5vw, 30px); font-weight: 800; margin-bottom: 10px; position: relative; letter-spacing: -0.02em; }
    .lp-cta-sub { color: var(--lp-cta-text); opacity: 0.8; font-size: 15px; margin-bottom: 28px; position: relative; line-height: 1.6; max-width: 440px; margin-left: auto; margin-right: auto; }
    .lp-cta-btn { background: var(--lp-bg); color: var(--lp-text); position: relative; }
    .lp-cta-btn:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.15); color: var(--lp-text); }

    /* ============ FORM ============ */
    .lp-form-section { background: var(--lp-surface); padding: 72px 24px; position: relative; z-index: 1; border-top: 1px solid var(--lp-border); }
    .lp-form-wrap { max-width: 440px; margin: 0 auto; background: var(--lp-surface); border: 1px solid var(--lp-border); border-radius: var(--lp-radius-lg); padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.08); }
    .lp-form-title { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    .lp-form-sub { font-size: 14px; color: var(--lp-text-muted); margin-bottom: 24px; }
    .lp-fg { margin-bottom: 14px; }
    .lp-fl { display: block; font-size: 13px; font-weight: 600; color: var(--lp-text); margin-bottom: 6px; }
    .lp-fi { width: 100%; padding: 14px 16px; background: var(--lp-surface); border: 1.5px solid var(--lp-border); border-radius: var(--lp-radius); font-family: var(--lp-font-body); font-size: 15px; color: var(--lp-text); outline: none; transition: border-color 0.3s, box-shadow 0.3s; }
    .lp-fi::placeholder { color: var(--lp-text-muted); }
    .lp-fi:focus { border-color: var(--lp-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lp-accent) 10%, transparent); background: var(--lp-bg); }
    textarea.lp-fi { resize: vertical; min-height: 100px; }
    .lp-fs { display: block; width: 100%; padding: 16px; background: var(--lp-cta); color: var(--lp-cta-text); font-family: var(--lp-font-body); font-size: 15px; font-weight: 600; border: none; border-radius: var(--lp-radius); cursor: pointer; transition: all var(--lp-transition); margin-top: 6px; }
    .lp-fs:hover { transform: translateY(-1px); box-shadow: 0 4px 16px color-mix(in srgb, var(--lp-cta) 25%, transparent); }
    .lp-fs:active { transform: translateY(0); }
    .lp-fs:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .lp-ft { text-align: center; font-size: 12px; color: var(--lp-text-muted); margin-top: 14px; display: flex; align-items: center; justify-content: center; gap: 5px; opacity: 0.7; }
    .lp-success { display: none; text-align: center; padding: 28px 0; }
    .lp-success.lp-show { display: block; }
    .lp-success-icon { width: 52px; height: 52px; border-radius: 50%; background: color-mix(in srgb, var(--lp-accent) 10%, transparent); border: 1px solid color-mix(in srgb, var(--lp-accent) 20%, transparent); display: flex; align-items: center; justify-content: center; margin: 0 auto 14px; animation: lp-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
    .lp-success-icon svg { width: 24px; height: 24px; color: var(--lp-accent); }
    .lp-success h3 { font-size: 20px; margin-bottom: 6px; }
    .lp-success p { font-size: 14px; color: var(--lp-text-muted); }
    @keyframes lp-pop { 0% { transform: scale(0); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }

    /* ============ FOOTER ============ */
    .lp-footer-wrap { border-top: 1px solid var(--lp-border); position: relative; z-index: 1; background: var(--lp-bg); }
    .lp-footer { max-width: var(--lp-container-wide); margin: 0 auto; padding: 24px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: var(--lp-text-muted); }

    /* ============ SCROLL REVEAL ============ */
    .reveal { opacity: 0; transform: translateY(16px); transition: opacity 0.5s ease, transform 0.5s ease; }
    .reveal.visible { opacity: 1; transform: translateY(0); }
    .reveal-d1 { transition-delay: 0.08s; }
    .reveal-d2 { transition-delay: 0.16s; }
    .reveal-d3 { transition-delay: 0.24s; }
    .reveal-d4 { transition-delay: 0.32s; }

    /* ============ RESPONSIVE — TABLET (≤1024px) ============ */
    @media (max-width: 1024px) {
      .lp-feat-grid { grid-template-columns: repeat(2, 1fr); }
      .lp-hero-2col { grid-template-columns: 1fr 1fr; gap: 32px; }
      .lp-vs-card { max-width: 100%; }
    }

    /* ============ RESPONSIVE — MOBILE (≤768px) ============ */
    @media (max-width: 768px) {
      .lp-hero { padding: 32px 0 48px; }
      .lp-hero-grid { grid-template-columns: 1fr !important; gap: 28px; }
      .lp-hero-copy { max-width: 100%; }
      .lp-section { padding: 48px 0; }
      .lp-section-header { margin-bottom: 28px; }
      .lp-feat-grid, .lp-feat-grid.lp-grid-3, .lp-feat-grid.lp-grid-4 { grid-template-columns: 1fr; }
      .lp-step-grid { flex-direction: column; align-items: center; gap: 24px; }
      .lp-step { max-width: 100%; }
      .lp-ba-grid { grid-template-columns: 1fr; }
      .lp-wif-grid { grid-template-columns: 1fr; }
      .lp-tfc-paths { grid-template-columns: 1fr; }
      .lp-cta-card { padding: 36px 24px; }
      .lp-bottom-cta { padding: 24px 0 56px; }
      .lp-btn { width: 100%; text-align: center; padding: 16px 24px; }
      .lp-vs-cta, .lp-price-btn { width: 100%; }
      .lp-testi-quote { font-size: 18px; }
      .lp-nav-inner { height: 56px; }
    }

    /* ============ DESIGN PASS v2 — editorial scale + rhythm ============ */
    body { font-size: 16.5px; line-height: 1.65; }
    body::before { display: none; } /* the dotted texture read as noise */
    ::selection { background: color-mix(in srgb, var(--lp-accent) 22%, transparent); }

    .lp-hero { padding: 72px 0 84px; }
    .lp-hero h1 { font-size: clamp(38px, 6vw, 58px); line-height: 1.06; letter-spacing: -0.03em; margin-bottom: 20px; }
    .lp-hero-sub { font-size: 18px; line-height: 1.7; max-width: 540px; }
    .lp-eyebrow { font-size: 12.5px; letter-spacing: 0.04em; text-transform: uppercase; }

    .lp-section { padding: 92px 0; }
    .lp-section + .lp-section { border-top: none; } /* rhythm comes from alternating surfaces, not rules */
    .lp-section-header { margin-bottom: 52px; }
    .lp-section-header h2 { font-size: clamp(30px, 4.6vw, 42px); letter-spacing: -0.025em; line-height: 1.12; max-width: 640px; margin-left: auto; margin-right: auto; }
    .lp-section-header p { font-size: 17px; max-width: 520px; margin: 10px auto 0; }

    .lp-btn, .lp-fs { font-size: 16px; padding: 17px 34px; letter-spacing: 0.01em; }
    .lp-btn:hover, .lp-fs:hover { transform: translateY(-2px); box-shadow: 0 10px 28px color-mix(in srgb, var(--lp-cta) 30%, transparent); }

    .lp-pp-card, .lp-feat-card, .lp-wif-col, .lp-tfc-path, .lp-ba-card { padding: 32px 28px; border-color: color-mix(in srgb, var(--lp-border) 70%, transparent); box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 8px 24px rgba(0,0,0,0.03); }
    .lp-pp-card h3, .lp-feat-card h3, .lp-step h3 { font-size: 18.5px; letter-spacing: -0.01em; }
    .lp-pp-card p, .lp-feat-card p, .lp-step p { font-size: 15px; line-height: 1.65; }
    .lp-feat-num { font-size: 44px; opacity: 0.14; }

    .lp-testi-quote { font-size: clamp(20px, 3vw, 26px); line-height: 1.55; letter-spacing: -0.01em; }
    .lp-story-body p { font-size: 17.5px; line-height: 1.85; }
    .lp-offer-list strong { font-size: 16.5px; }
    .lp-offer-list p { font-size: 15px; }
    .lp-offer-list li { padding: 20px 0; }
    .lp-faq-item summary { font-size: 16.5px; padding: 22px 0; }
    .lp-faq-a { font-size: 15.5px; line-height: 1.75; }
    .lp-wif-list li { font-size: 15px; padding: 8px 0; }
    .lp-tfc-path-a p, .lp-tfc-path-b p { font-size: 15px; line-height: 1.75; }
    .lp-vs-item-name { font-size: 16px; }
    .lp-vs-item-desc { font-size: 14px; }
    .lp-vs-price-amount { font-size: clamp(42px, 6vw, 56px); }
    .lp-price-amount { font-size: clamp(42px, 6vw, 56px); }

    .lp-cta-card { padding: 60px 44px; }
    .lp-cta-card h2 { font-size: clamp(28px, 4.2vw, 38px); margin-bottom: 12px; }
    .lp-cta-sub { font-size: 16.5px; }
    .lp-form-title { font-size: 24px; letter-spacing: -0.015em; }
    .lp-form-wrap { padding: 38px 34px; }
    .lp-fi { font-size: 16px; padding: 15px 16px; }
    .lp-footer { padding: 32px 24px; }

    @media (max-width: 768px) {
      .lp-hero { padding: 44px 0 56px; }
      .lp-hero h1 { font-size: clamp(32px, 8.5vw, 40px); }
      .lp-section { padding: 60px 0; }
      .lp-section-header { margin-bottom: 34px; }
      .lp-cta-card { padding: 42px 26px; }
    }

    /* ============ RESPONSIVE — SMALL MOBILE (≤480px) ============ */
    @media (max-width: 480px) {
      .lp-container, .lp-wide { padding: 0 16px; }
      .lp-hero { padding: 24px 0 36px; }
      .lp-hero h1 { font-size: 28px; }
      .lp-section { padding: 36px 0; }
      .lp-section-header h2 { font-size: 24px; }
      .lp-form-wrap { padding: 20px; }
      .lp-pp-card, .lp-feat-card, .lp-ba-card, .lp-wif-col, .lp-tfc-path { padding: 20px 16px; }
      .lp-vs-card { padding: 28px 20px; }
      .lp-vs-item { flex-direction: column; gap: 4px; align-items: flex-start; }
      .lp-vs-item-value { text-align: left; }
      .lp-footer { flex-direction: column; gap: 8px; text-align: center; }
    }
  `
}

// ---------------------------------------------------------------------------
// Form HTML
// ---------------------------------------------------------------------------
function formHTML(fields: AssembleOptions['formFields'], title?: string, subtitle?: string, buttonText?: string, thankYouHeadline?: string, thankYouMessage?: string): string {
  if (fields.length === 0) return ''
  const formTitle = title || 'Get your free copy'
  const formSub = subtitle || 'Enter your details and we\'ll send it straight to your inbox.'
  const btnText = buttonText || 'Submit'
  const inputs = fields.map(f => {
    const id = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')
    const req = f.required ? ' required' : ''
    const lbl = esc(f.label)
    if (f.type === 'textarea') {
      return `<div class="lp-fg"><label class="lp-fl" for="${id}">${lbl}</label><textarea class="lp-fi" id="${id}" name="${id}" placeholder="${lbl}"${req}></textarea></div>`
    }
    const type = f.type === 'phone' ? 'tel' : (f.type || 'text')
    return `<div class="lp-fg"><label class="lp-fl" for="${id}">${lbl}</label><input class="lp-fi" type="${esc(type)}" id="${id}" name="${id}" placeholder="${lbl}"${req} /></div>`
  }).join('\n      ')

  return `<section id="form" class="lp-form-section">
    <div class="lp-form-wrap">
      <h3 class="lp-form-title">${esc(formTitle)}</h3>
      <p class="lp-form-sub">${esc(formSub)}</p>
      <form id="lp-form">
      ${inputs}
      <div style="position:absolute;left:-9999px;top:-9999px;height:0;width:0;overflow:hidden" aria-hidden="true"><label>Company website<input type="text" name="company_website" tabindex="-1" autocomplete="off" /></label></div>
      <button type="submit" class="lp-fs">${esc(btnText)}</button>
      </form>
      <p class="lp-ft"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Your information is secure.</p>
      <div id="lp-success" class="lp-success">
        <div class="lp-success-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg></div>
        <h3>${esc(thankYouHeadline || 'Thank you!')}</h3>
        <p>${esc(thankYouMessage || "We'll be in touch soon.")}</p>
      </div>
    </div>
  </section>`
}

function checkoutFormHTML(): string {
  return `<section id="form" class="lp-form-section">
    <div class="lp-form-wrap" style="text-align:center">
      <h3 class="lp-form-title">Complete Your Purchase</h3>
      <p class="lp-form-sub">Enter your email to proceed to secure checkout.</p>
      <form id="lp-form">
        <div class="lp-fg"><label class="lp-fl" for="email">Email</label><input class="lp-fi" type="email" id="email" name="email" placeholder="Your email address" required /></div>
        <button type="submit" class="lp-fs">Proceed to Checkout</button>
      </form>
      <p class="lp-ft"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Secure checkout powered by Stripe</p>
      <div id="lp-success" class="lp-success">
        <div class="lp-success-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg></div>
        <h3>Redirecting to checkout...</h3>
        <p>You'll be taken to our secure payment page.</p>
      </div>
    </div>
  </section>`
}

// ---------------------------------------------------------------------------
// Form script
// ---------------------------------------------------------------------------
function formScript(formAction: string): string {
  return `<script>
(function(){
  var form = document.getElementById('lp-form');
  if (!form) return;
  var submitting = false;
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    var data = {};
    new FormData(form).forEach(function(v, k) { data[k] = v; });
    var params = new URLSearchParams(window.location.search);
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(function(k) { var v = params.get(k); if (v) data['_' + k] = v; });
    if (document.referrer) data['_referrer'] = document.referrer;
    // Pass funnel context through to the submit handler so it can save email + advance
    ['funnel_sid','funnel_step','funnel_slug'].forEach(function(k) { var v = params.get(k); if (v) data[k] = v; });
    var btn = form.querySelector('[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

    fetch('${escJs(formAction)}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: data }) })
    .then(function(r) { return r.json(); })
    .then(function(r) {
      if (r.ok) {
        if (r.redirectUrl) { window.location.href = r.redirectUrl; return; }
        form.style.display = 'none';
        var ft = document.querySelector('.lp-ft') || document.querySelector('.sp-trust');
        if (ft) ft.style.display = 'none';
        var s = document.getElementById('lp-success');
        if (s) { s.classList.add('lp-show'); if (r.message) s.querySelector('p').textContent = r.message; }
      } else {
        alert(r.error || 'Something went wrong');
        submitting = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
      }
    }).catch(function() { submitting = false; if (btn) { btn.disabled = false; btn.textContent = 'Try Again'; } });
  });
})();
</script>`
}

// ---------------------------------------------------------------------------
// Checkout script (Stripe)
// ---------------------------------------------------------------------------
function checkoutScript(productId: string, slug: string): string {
  const base = typeof process !== 'undefined' ? (process.env.APP_URL || '') : ''
  return `<script>
(function(){
  var form = document.getElementById('lp-form');
  if (!form) return;
  var submitting = false;
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    var data = {};
    new FormData(form).forEach(function(v, k) { data[k] = v; });
    var params = new URLSearchParams(window.location.search);
    ['funnel_sid','funnel_step','funnel_slug'].forEach(function(k) { var v = params.get(k); if (v) data[k] = v; });
    var btn = form.querySelector('[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Redirecting to checkout...'; }
    var fSid = data.funnel_sid || ''; var fStep = data.funnel_step || ''; var fSlug = data.funnel_slug || '';
    if (fSid && fSlug) {
      if (btn) btn.textContent = 'Adding to order...';
      fetch('/api/funnels/public/' + fSlug + '/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: fSid, stepId: fStep, name: data.name || data.Name || '', email: data.email || data.Email || '' }) })
      .then(function(r) { return r.json(); })
      .then(function(r) { if (r.ok && r.redirectUrl) { window.location.href = r.redirectUrl; } else { alert(r.error || 'Something went wrong.'); submitting = false; if (btn) { btn.disabled = false; btn.textContent = 'Buy Now'; } } })
      .catch(function() { alert('Something went wrong.'); submitting = false; if (btn) { btn.disabled = false; btn.textContent = 'Buy Now'; } });
      return;
    }
    fetch('${escJs(base)}/api/landing-page-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: '${escJs(productId)}', email: data.email || data.Email || '', name: data.name || data.Name || '', landingPageSlug: '${escJs(slug)}' }) })
    .then(function(r) { return r.json(); })
    .then(function(r) { if (r.ok && r.checkoutUrl) { window.location.href = r.checkoutUrl; } else { alert(r.error || 'Checkout unavailable.'); submitting = false; if (btn) { btn.disabled = false; btn.textContent = 'Buy Now'; } } })
    .catch(function() { alert('Something went wrong.'); submitting = false; if (btn) { btn.disabled = false; btn.textContent = 'Buy Now'; } });
  });
})();
</script>`
}

// ---------------------------------------------------------------------------
// Upsell accept/decline script (reads funnel params from URL)
// ---------------------------------------------------------------------------
function upsellScript(): string {
  return `<script>
function _funnelAct(action){
  var params = new URLSearchParams(window.location.search);
  var sid = params.get('funnel_sid') || '';
  var step = params.get('funnel_step') || '';
  var slug = params.get('funnel_slug') || '';
  if (!sid || !slug) { alert('Funnel context not found. This page must be accessed through a funnel.'); return; }
  var btns = document.getElementById('funnel-btns');
  var loading = document.getElementById('funnel-loading');
  if (btns) btns.style.display = 'none';
  if (loading) loading.style.display = 'block';
  fetch('/api/funnels/public/' + slug + '/upsell', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid: sid, stepId: step, action: action })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d.redirectUrl) window.location.href = d.redirectUrl;
    else { if (loading) loading.textContent = d.error || 'Something went wrong'; if (btns) btns.style.display = 'block'; }
  })
  .catch(function() { if (loading) loading.textContent = 'Something went wrong'; if (btns) btns.style.display = 'block'; });
}
</script>`
}

// ---------------------------------------------------------------------------
// Funnel checkout script (reads funnel params from URL, submits to funnel checkout)
// ---------------------------------------------------------------------------
function funnelCheckoutScript(): string {
  return `<script>
(function(){
  var form = document.getElementById('lp-form');
  if (!form) return;
  var submitting = false;
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    var data = {};
    new FormData(form).forEach(function(v, k) { data[k] = v; });
    var params = new URLSearchParams(window.location.search);
    var sid = params.get('funnel_sid') || '';
    var step = params.get('funnel_step') || '';
    var slug = params.get('funnel_slug') || '';
    var btn = form.querySelector('[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Redirecting to payment...'; }
    if (!sid || !slug) {
      alert('This checkout page must be accessed through a funnel.');
      submitting = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Proceed to Payment'; }
      return;
    }
    fetch('/api/funnels/public/' + slug + '/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: sid, stepId: step, name: data.name || '', email: data.email || '' })
    })
    .then(function(r) { return r.json(); })
    .then(function(r) {
      if (r.ok && r.checkoutUrl) window.location.href = r.checkoutUrl;
      else { alert(r.error || 'Checkout unavailable.'); submitting = false; if (btn) { btn.disabled = false; btn.textContent = 'Proceed to Payment'; } }
    })
    .catch(function() { alert('Something went wrong.'); submitting = false; if (btn) { btn.disabled = false; btn.textContent = 'Proceed to Payment'; } });
  });
})();
</script>`
}

// ---------------------------------------------------------------------------
// Booking embed
// ---------------------------------------------------------------------------
function bookingEmbed(slug: string): string {
  return `<section id="booking" class="lp-form-section">
  <div style="max-width:960px;margin:0 auto">
    <iframe src="/api/calendar/book/${esc(slug)}" style="width:100%;min-height:700px;border:none;border-radius:var(--lp-radius-lg)" title="Book a call" loading="lazy"></iframe>
  </div>
</section>`
}

// ---------------------------------------------------------------------------
// Reveal observer
// ---------------------------------------------------------------------------
const revealScript = `<script>
(function(){
  var r = document.querySelectorAll('.reveal');
  if (!r.length) return;
  var o = new IntersectionObserver(function(e) { e.forEach(function(en) { if (en.isIntersecting) { en.target.classList.add('visible'); o.unobserve(en.target); } }); }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
  r.forEach(function(el) { o.observe(el); });
})();
</script>`

// ---------------------------------------------------------------------------
// Simple centered page — standalone layout: headline, subtitle, bullets, form
// ---------------------------------------------------------------------------
export interface SimplePageOptions {
  style: StyleDefinition
  pageTitle: string
  headline: string
  subtitle: string
  bullets: string[]
  ctaText: string
  formFields: { label: string; type: string; required: boolean }[]
  formAction: string
  slug: string
  businessName?: string
  metaDescription?: string
  productId?: string | null
}

export function assembleSimplePage(options: SimplePageOptions): string {
  const { style, pageTitle, headline, subtitle, bullets, ctaText, formFields, formAction, slug, businessName, metaDescription } = options
  const title = esc(pageTitle)
  const desc = metaDescription ? esc(metaDescription) : ''
  const brand = businessName ? esc(businessName) : ''
  const year = new Date().getFullYear()

  const checkSvgLocal = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>'

  const bulletsHtml = bullets.length > 0
    ? bullets.map((b, i) => `<li class="reveal reveal-d${Math.min(i + 1, 4)}"><span class="sp-check">${checkSvgLocal}</span><span>${esc(b)}</span></li>`).join('\n          ')
    : ''

  const inputs = formFields.map(f => {
    const id = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')
    const req = f.required ? ' required' : ''
    const lbl = esc(f.label)
    if (f.type === 'textarea') {
      return `<div class="sp-fg"><label class="sp-fl" for="${id}">${lbl}</label><textarea class="sp-fi" id="${id}" name="${id}" placeholder="${lbl}"${req}></textarea></div>`
    }
    const type = f.type === 'phone' ? 'tel' : (f.type || 'text')
    return `<div class="sp-fg"><label class="sp-fl" for="${id}">${lbl}</label><input class="sp-fi" type="${esc(type)}" id="${id}" name="${id}" placeholder="${lbl}"${req} /></div>`
  }).join('\n          ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  ${desc ? `<meta name="description" content="${desc}" />` : ''}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="${esc(style.googleFontsUrl)}" rel="stylesheet" />
  <style>
    ${cssVars(style)}
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { font-family: var(--lp-font-body); color: var(--lp-text); background: var(--lp-bg); line-height: 1.6; font-size: 15px; -webkit-font-smoothing: antialiased; min-height: 100vh; display: flex; flex-direction: column; }

    .sp-main { flex: 1; display: flex; align-items: center; justify-content: center; padding: clamp(40px, 8vw, 100px) 24px; }
    .sp-container { max-width: 1100px; width: 100%; text-align: center; }

    .sp-brand { font-family: var(--lp-font-display); font-weight: 700; font-size: 15px; color: var(--lp-text-muted); letter-spacing: 0.04em; margin-bottom: 40px; }

    .sp-h1 { font-family: var(--lp-font-display); font-weight: 800; font-size: clamp(32px, 5.5vw, 56px); line-height: 1.1; letter-spacing: -0.025em; color: var(--lp-text); margin-bottom: 20px; max-width: 1100px; margin-left: auto; margin-right: auto; }

    .sp-sub { font-size: clamp(16px, 2vw, 19px); color: var(--lp-text-muted); line-height: 1.7; margin-bottom: 36px; max-width: 750px; margin-left: auto; margin-right: auto; }

    .sp-bullets { list-style: none; text-align: left; display: inline-block; margin-bottom: 40px; }
    .sp-bullets li { display: flex; align-items: flex-start; gap: 12px; padding: 6px 0; font-size: 15px; color: var(--lp-text); }
    .sp-check { color: var(--lp-accent); flex-shrink: 0; margin-top: 1px; }

    .sp-form-card { background: var(--lp-surface); border: 1px solid var(--lp-border); border-radius: var(--lp-radius-lg); padding: 32px; text-align: left; box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.06); max-width: 440px; margin-left: auto; margin-right: auto; }
    .sp-fg { margin-bottom: 14px; }
    .sp-fl { display: block; font-size: 13px; font-weight: 600; color: var(--lp-text); margin-bottom: 6px; }
    .sp-fi { width: 100%; padding: 14px 16px; background: var(--lp-bg); border: 1.5px solid var(--lp-border); border-radius: var(--lp-radius); font-family: var(--lp-font-body); font-size: 15px; color: var(--lp-text); outline: none; transition: border-color 0.3s, box-shadow 0.3s; }
    .sp-fi::placeholder { color: var(--lp-text-muted); }
    .sp-fi:focus { border-color: var(--lp-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lp-accent) 10%, transparent); }
    textarea.sp-fi { resize: vertical; min-height: 80px; }
    .sp-submit { display: block; width: 100%; padding: 16px; background: var(--lp-cta); color: var(--lp-cta-text); font-family: var(--lp-font-body); font-size: 15px; font-weight: 600; border: none; border-radius: var(--lp-radius); cursor: pointer; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); margin-top: 6px; }
    .sp-submit:hover { transform: translateY(-1px); box-shadow: 0 4px 16px color-mix(in srgb, var(--lp-cta) 25%, transparent); }
    .sp-submit:active { transform: translateY(0); }
    .sp-submit:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .sp-trust { text-align: center; font-size: 12px; color: var(--lp-text-muted); margin-top: 14px; display: flex; align-items: center; justify-content: center; gap: 5px; opacity: 0.6; }
    .sp-success { display: none; text-align: center; padding: 24px 0; }
    .sp-success.sp-show { display: block; }
    .sp-success h3 { font-family: var(--lp-font-display); font-size: 20px; margin-bottom: 6px; color: var(--lp-text); }
    .sp-success p { font-size: 14px; color: var(--lp-text-muted); }

    .sp-footer { text-align: center; padding: 20px 24px; font-size: 12px; color: var(--lp-text-muted); border-top: 1px solid var(--lp-border); }

    .reveal { opacity: 0; transform: translateY(12px); transition: opacity 0.5s ease, transform 0.5s ease; }
    .reveal.visible { opacity: 1; transform: translateY(0); }
    .reveal-d1 { transition-delay: 0.06s; }
    .reveal-d2 { transition-delay: 0.12s; }

    @media (max-width: 768px) {
      .sp-main { padding: clamp(32px, 6vw, 60px) 20px; }
      .sp-h1 { font-size: clamp(28px, 6vw, 40px); }
      .sp-bullets { padding: 0 8px; }
      .sp-form-card { max-width: 100%; }
    }
    @media (max-width: 480px) {
      .sp-main { padding: 28px 16px; align-items: flex-start; }
      .sp-brand { margin-bottom: 24px; }
      .sp-h1 { font-size: 26px; margin-bottom: 14px; }
      .sp-sub { font-size: 15px; margin-bottom: 28px; }
      .sp-form-card { padding: 20px; }
      .sp-bullets li { font-size: 14px; }
    }
  </style>
</head>
<body>
  <main class="sp-main">
    <div class="sp-container">
      <div class="sp-brand reveal">${brand || title}</div>
      <h1 class="sp-h1 reveal">${esc(headline)}</h1>
      <p class="sp-sub reveal">${esc(subtitle)}</p>
      ${bulletsHtml ? `<ul class="sp-bullets">\n          ${bulletsHtml}\n        </ul>` : ''}
      <div class="sp-form-card reveal reveal-d2">
        <form id="lp-form">
          ${inputs}
          <button type="submit" class="sp-submit">${esc(ctaText)}</button>
        </form>
        <p class="sp-trust"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>No spam. Unsubscribe anytime.</p>
        <div id="lp-success" class="sp-success">
          <h3>Check your inbox!</h3>
          <p>We'll be in touch soon.</p>
        </div>
      </div>
    </div>
  </main>
  <footer class="sp-footer">&copy; ${year} ${brand || title}</footer>
${options.productId ? checkoutScript(options.productId, slug) : formScript(formAction)}
${revealScript}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Hero builder — knows about form placement and images
// ---------------------------------------------------------------------------
function buildHero(heroSection: GeneratedSection | undefined, options: AssembleOptions, heroFormHtml: string): string {
  if (!heroSection) return ''
  const h = esc(getHeadline(heroSection))
  const sub = heroSection.subtitle ? esc(heroSection.subtitle) : ''
  const cta = esc(getCtaText(heroSection))
  const imgUrl = options.heroImageUrl
  const hasRightCol = heroFormHtml || imgUrl

  // Dynamic eyebrow based on page type
  const pageType = options.pageType || ''
  const eyebrowMap: Record<string, string> = {
    'capture-leads': 'Free Resource',
    'book-a-call': 'Book a Call',
    'sell-digital': 'Digital Product',
    'sell-physical': 'Shop Now',
    'sell-service': 'Professional Service',
    'promote-event': 'Upcoming Event',
    'general': '',
    'upsell': 'Special Offer',
    'downsell': 'Limited Offer',
    'funnel-checkout': 'Secure Checkout',
  }
  const eyebrowText = eyebrowMap[pageType] || ''

  // Build the right column content
  let rightCol = ''
  if (heroFormHtml) {
    // Form card in hero (lead capture / event pages)
    rightCol = `<div class="lp-hero-right reveal reveal-d3">${heroFormHtml}</div>`
  } else if (imgUrl) {
    // Image in hero (sell / service pages)
    rightCol = `<div class="lp-hero-right reveal reveal-d3"><img src="${esc(imgUrl)}" alt="${esc(options.pageTitle)}" class="lp-hero-img" /></div>`
  }
  // No right column = single column hero (cleaner for pages without image/form in hero)

  if (hasRightCol) {
    return `<section class="lp-hero">
  <div class="lp-wide">
    <div class="lp-hero-grid lp-hero-2col">
      <div class="lp-hero-copy">
        ${eyebrowText ? `<div class="lp-eyebrow reveal">${downloadSvg} ${eyebrowText}</div>` : ''}
        <h1 class="reveal reveal-d1">${h}</h1>
        ${sub ? `<p class="lp-hero-sub reveal reveal-d2">${sub}</p>` : ''}
        ${!heroFormHtml ? `<a href="#form" class="lp-btn reveal reveal-d3">${cta}</a>` : ''}
      </div>
      ${rightCol}
    </div>
  </div>
</section>`
  }

  // Upsell/downsell hero with pattern interrupt
  const isUpsellHero = pageType === 'upsell' || pageType === 'downsell'
  if (isUpsellHero) {
    const interruptText = pageType === 'downsell'
      ? 'Wait — before you go!'
      : 'Great choice! One more thing...'
    const interruptColor = pageType === 'downsell' ? '#f59e0b' : '#16a34a'

    const declineLabel = pageType === 'downsell' ? "No thanks, I'll pass" : "No thanks, skip this offer"

    return `<div style="background:${interruptColor};color:#fff;text-align:center;padding:14px 24px;font-size:15px;font-weight:700;letter-spacing:0.02em">${interruptText}</div>
<section class="lp-hero" style="padding-top:64px;padding-bottom:64px">
  <div class="lp-wide" style="text-align:center">
    <div class="lp-hero-copy" style="max-width:800px;margin:0 auto">
      <h1 class="reveal reveal-d1" style="font-size:clamp(28px,4.5vw,44px);margin-bottom:20px">${h}</h1>
      ${sub ? `<p class="lp-hero-sub reveal reveal-d2" style="max-width:650px;margin-left:auto;margin-right:auto;font-size:clamp(16px,2vw,19px);line-height:1.6;margin-bottom:32px">${sub}</p>` : ''}
      <a href="javascript:void(0)" onclick="_funnelAct('accept')" class="lp-btn reveal reveal-d3" style="font-size:18px;padding:18px 36px">${cta}</a>
      <div class="reveal reveal-d4" style="margin-top:16px">
        <a href="javascript:void(0)" onclick="_funnelAct('decline')" style="font-size:13px;color:var(--lp-text-muted);text-decoration:underline;cursor:pointer">${declineLabel}</a>
      </div>
    </div>
  </div>
</section>`
  }

  // Single column centered hero (no image, no inline form)
  return `<section class="lp-hero">
  <div class="lp-wide" style="text-align:center">
    <div class="lp-hero-copy" style="max-width:1100px;margin:0 auto">
      <div class="lp-eyebrow reveal" style="justify-content:center">${downloadSvg} ${eyebrowText || 'Free Resource'}</div>
      <h1 class="reveal reveal-d1">${h}</h1>
      ${sub ? `<p class="lp-hero-sub reveal reveal-d2" style="max-width:750px;margin-left:auto;margin-right:auto">${sub}</p>` : ''}
      <a href="#form" class="lp-btn reveal reveal-d3">${cta}</a>
    </div>
  </div>
</section>`
}

// Inline form card for hero (no section wrapper, just the card)
function heroFormCard(fields: AssembleOptions['formFields']): string {
  if (fields.length === 0) return ''
  const inputs = fields.map(f => {
    const id = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '')
    const req = f.required ? ' required' : ''
    const lbl = esc(f.label)
    if (f.type === 'textarea') {
      return `<div class="lp-fg"><label class="lp-fl" for="${id}">${lbl}</label><textarea class="lp-fi" id="${id}" name="${id}" placeholder="${lbl}"${req}></textarea></div>`
    }
    const type = f.type === 'phone' ? 'tel' : (f.type || 'text')
    return `<div class="lp-fg"><label class="lp-fl" for="${id}">${lbl}</label><input class="lp-fi" type="${esc(type)}" id="${id}" name="${id}" placeholder="${lbl}"${req} /></div>`
  }).join('\n        ')

  return `<div class="lp-form-wrap" id="form">
      <h3 class="lp-form-title">Get your free copy</h3>
      <p class="lp-form-sub">Enter your details and we'll send it straight to your inbox.</p>
      <form id="lp-form">
        ${inputs}
        <button type="submit" class="lp-fs">Download Free Guide</button>
      </form>
      <p class="lp-ft"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>No spam, ever. Unsubscribe anytime.</p>
      <div id="lp-success" class="lp-success">
        <div class="lp-success-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg></div>
        <h3>Check your inbox!</h3>
        <p>We'll be in touch soon.</p>
      </div>
    </div>`
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------
export function assemblePage(options: AssembleOptions): string {
  const { sections, style, pageTitle, metaDescription, formFields, formAction, slug, businessName, bookingPageSlug } = options
  const isBooking = Boolean(bookingPageSlug)
  const pageType = options.pageType || ''
  const title = esc(pageTitle)
  const desc = metaDescription ? esc(metaDescription) : ''
  const brand = businessName ? esc(businessName) : ''
  const year = new Date().getFullYear()

  // Decide if form goes in hero or at bottom
  const isSellPage = ['sell-digital', 'sell-physical', 'sell-service'].includes(pageType)
  const isUpsellOrDownsell = pageType === 'upsell' || pageType === 'downsell'
  const isFunnelCheckout = pageType === 'funnel-checkout'
  const hasProduct = Boolean(options.productId)
  const formInHero = ['capture-leads', 'promote-event'].includes(pageType) && !isBooking && !isUpsellOrDownsell && formFields.length > 0
  const formAtBottom = !formInHero && !isBooking && !isUpsellOrDownsell && !isFunnelCheckout && formFields.length > 0

  // Build hero separately (it needs form/image context)
  const heroSection = sections.find(s => s.type === 'hero')
  const heroFormContent = formInHero ? heroFormCard(formFields) : ''
  const heroHtml = buildHero(heroSection, options, heroFormContent)

  // Render remaining sections (skip hero — we built it above). Sections whose
  // item lists came back empty (e.g. testimonials when the user gave no social
  // proof) are dropped instead of rendering hollow shells.
  const otherSections = sections.filter(s => s && typeof s.type === 'string' && s.type !== 'hero').filter(s => {
    const anyS = s as Record<string, any>
    const lists = [anyS.items, anyS.faqItems, anyS.valueItems, anyS.forItems]
    const declaredEmpty = lists.some(l => Array.isArray(l) && l.length === 0)
    const hasAnyContent = lists.some(l => Array.isArray(l) && l.length > 0)
      || [anyS.body, anyS.subtitle, anyS.inactionText, anyS.actionText, anyS.price]
        .some(v => typeof v === 'string' && v.trim().length > 0)
    return hasAnyContent || !declaredEmpty
  })
  const sectionsHtml = otherSections.map((s, i) => renderSection(s, i + 1)).join('\n')

  // Extract CTA text from hero for the bottom form button
  const heroCta = heroSection ? getCtaText(heroSection) : undefined

  // Bottom action section
  let actionHtml = ''
  if (isUpsellOrDownsell) {
    const acceptText = heroCta || (pageType === 'downsell' ? 'Yes! I want this deal' : 'Yes! Add this to my order')
    const declineText = pageType === 'downsell' ? "No thanks, take me to my purchase" : "No thanks, I'll pass"
    actionHtml = `<section id="action" class="lp-form-section">
    <div class="lp-form-wrap" style="text-align:center">
      <div id="funnel-btns">
        <button onclick="_funnelAct('accept')" class="lp-fs" style="background:var(--lp-cta);color:var(--lp-cta-text);font-size:16px;padding:18px;margin-bottom:12px">✓ ${esc(acceptText)}</button>
        <button onclick="_funnelAct('decline')" style="display:block;width:100%;padding:12px;border:none;background:none;font-size:13px;color:var(--lp-text-muted);cursor:pointer;text-decoration:underline">${esc(declineText)}</button>
      </div>
      <div id="funnel-loading" style="display:none;text-align:center;padding:20px;color:var(--lp-text-muted)">Processing...</div>
    </div>
  </section>`
  } else if (isFunnelCheckout) {
    actionHtml = `<section id="form" class="lp-form-section">
    <div class="lp-form-wrap">
      <h3 class="lp-form-title">Complete Your Purchase</h3>
      <p class="lp-form-sub">Enter your details to proceed to secure checkout.</p>
      <form id="lp-form">
        <div class="lp-fg"><label class="lp-fl" for="name">Name</label><input class="lp-fi" type="text" id="name" name="name" placeholder="Your name" required /></div>
        <div class="lp-fg"><label class="lp-fl" for="email">Email</label><input class="lp-fi" type="email" id="email" name="email" placeholder="you@example.com" required /></div>
        <button type="submit" class="lp-fs">Proceed to Payment</button>
      </form>
      <p class="lp-ft"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Secure checkout powered by Stripe</p>
    </div>
  </section>`
  } else if (isBooking) {
    actionHtml = bookingEmbed(bookingPageSlug!)
  } else if (formAtBottom && hasProduct) {
    // Product checkout: simple email form that triggers Stripe
    actionHtml = checkoutFormHTML()
  } else if (formAtBottom && isSellPage) {
    // Service inquiry (no product linked)
    actionHtml = formHTML(formFields, 'Apply Now', 'Tell us about your needs and we\'ll get back to you within 24 hours.', heroCta, options.thankYouHeadline || undefined, options.thankYouMessage || undefined)
  } else if (formAtBottom) {
    actionHtml = formHTML(formFields, undefined, undefined, heroCta, options.thankYouHeadline || undefined, options.thankYouMessage || undefined)
  }

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  ${desc ? `<meta name="description" content="${desc}" />` : ''}
  <meta property="og:title" content="${title}" />
  ${desc ? `<meta property="og:description" content="${desc}" />` : ''}
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${title}" />
  ${desc ? `<meta name="twitter:description" content="${desc}" />` : ''}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="${esc(style.googleFontsUrl)}" rel="stylesheet" />
  <style>${cssVars(style)}${baseCSS()}</style>
</head>
<body>
  <nav class="lp-nav">
    <div class="lp-nav-inner">
      <a href="/" class="lp-nav-brand">${brand || title}</a>
    </div>
  </nav>
${heroHtml}
${sectionsHtml}
${actionHtml}
  <div class="lp-footer-wrap">
    <footer class="lp-footer">
      <p>&copy; ${year} ${brand || title}. All rights reserved.</p>
    </footer>
  </div>
${isUpsellOrDownsell ? upsellScript() : isFunnelCheckout ? funnelCheckoutScript() : (!isBooking && formFields.length > 0 ? (options.productId ? checkoutScript(options.productId, options.slug) : formScript(formAction)) : '')}
${revealScript}
</body>
</html>`

  if (isBooking) html = html.replace(/href="#form"/g, 'href="#booking"')
  if (isUpsellOrDownsell) html = html.replace(/href="#form"/g, 'href="javascript:void(0)" onclick="_funnelAct(\'accept\')"')
  return html
}
