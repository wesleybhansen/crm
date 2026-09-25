/**
 * Server-side rendering for pages built with the AI wizard (config
 * `wizardVersion: 2`), shared by the publish route and the section editor.
 *
 * Pure: no database access, so the exact wizard config shape can be tested.
 * Rendering errors are thrown with context instead of swallowed, so a failed
 * publish says why.
 */
import { assemblePage, assembleSimplePage } from '../../../lib/landing-page-wizard/page-assembler'
import { getStyleById } from '../../../lib/landing-page-wizard/styles'
import type { GeneratedSection, StyleDefinition } from '../../../lib/landing-page-wizard/types'

export const DEFAULT_WIZARD_STYLE_ID = 'minimal'

type WizardFormField = { label: string; type: string; required: boolean }

export type WizardConfig = {
  wizardVersion?: number
  pageType?: string | null
  subType?: string | null
  generatedSections?: GeneratedSection[]
  styleId?: string | null
  formFields?: WizardFormField[]
  metaDescription?: string
  businessContext?: { businessName?: string }
  bookingPageSlug?: string | null
  productId?: string | null
  heroImageUrl?: string | null
  thankYouHeadline?: string | null
  thankYouMessage?: string | null
  simpleLayout?: boolean
  [key: string]: unknown
}

export type EditorSection = {
  id: string
  type: string
  fields: Record<string, any>
  html: string
}

export function isWizardV2Config(config: unknown): config is WizardConfig {
  return !!config && typeof config === 'object' && (config as WizardConfig).wizardVersion === 2
}

/** Sections the wizard generated, keeping only well-formed entries. */
export function wizardSections(config: WizardConfig): GeneratedSection[] {
  const raw = Array.isArray(config.generatedSections) ? config.generatedSections : []
  return raw.filter((s): s is GeneratedSection => !!s && typeof s === 'object' && typeof (s as GeneratedSection).type === 'string')
}

export function resolveWizardStyle(styleId: string | null | undefined): StyleDefinition {
  const style = (styleId && getStyleById(styleId)) || getStyleById(DEFAULT_WIZARD_STYLE_ID)
  if (!style) throw new Error(`No landing page style found for "${styleId}" or the default "${DEFAULT_WIZARD_STYLE_ID}"`)
  if (styleId && style.id !== styleId) {
    console.warn(`[landing_pages.render] Unknown style "${styleId}", using "${style.id}"`)
  }
  return style
}

/**
 * Render a wizard page to full HTML. Throws (with the reason) when the page
 * has nothing to render, instead of returning null.
 */
export function renderWizardPageHtml(
  config: WizardConfig,
  page: { title: string; slug: string },
  formAction: string,
): string {
  const sections = wizardSections(config)
  if (sections.length === 0) {
    throw new Error('The page has no generated sections to render')
  }
  const style = resolveWizardStyle(config.styleId)
  const formFields = Array.isArray(config.formFields) ? config.formFields : []
  const businessName = config.businessContext?.businessName || undefined

  if (config.simpleLayout) {
    const hero = sections.find((s) => s.type === 'hero') || sections[0]
    return assembleSimplePage({
      style,
      pageTitle: page.title,
      headline: hero?.headline || page.title,
      subtitle: hero?.subtitle || '',
      bullets: Array.isArray((hero as any)?.bullets) ? (hero as any).bullets : [],
      ctaText: hero?.ctaText || 'Get Started',
      formFields,
      formAction,
      slug: page.slug,
      businessName,
      metaDescription: config.metaDescription,
      productId: config.productId || null,
      pageType: config.pageType || null,
      subType: config.subType || null,
      thankYouHeadline: config.thankYouHeadline || null,
      thankYouMessage: config.thankYouMessage || null,
    })
  }

  return assemblePage({
    sections,
    style,
    pageTitle: page.title,
    metaDescription: config.metaDescription,
    formFields,
    formAction,
    slug: page.slug,
    businessName,
    bookingPageSlug: config.bookingPageSlug || null,
    productId: config.productId || null,
    pageType: config.pageType || null,
    subType: config.subType || null,
    heroImageUrl: config.heroImageUrl || null,
    thankYouHeadline: config.thankYouHeadline || null,
    thankYouMessage: config.thankYouMessage || null,
  })
}

/** Wizard sections -> the editor's `{ id, type, fields }` shape. */
export function generatedSectionsToEditorSections(sections: GeneratedSection[]): EditorSection[] {
  return sections.map((section, index) => {
    const { type, ...fields } = section as GeneratedSection & Record<string, any>
    return { id: `section-${index}`, type, fields, html: '' }
  })
}

/** The editor's sections -> wizard sections (inverse of the above). */
export function editorSectionsToGeneratedSections(sections: unknown): GeneratedSection[] {
  if (!Array.isArray(sections)) return []
  return sections
    .filter((s): s is EditorSection => !!s && typeof s === 'object' && typeof (s as EditorSection).type === 'string')
    .map((s) => {
      const section = { ...(s.fields || {}), type: s.type } as GeneratedSection
      // The editor edits `headline` / `ctaText` directly. A chosen AI variant
      // would otherwise win at render time and hide the edit.
      if (section.headlineVariants && section.selectedHeadline !== undefined
        && section.headlineVariants[section.selectedHeadline] !== section.headline) {
        delete section.selectedHeadline
      }
      if (section.ctaVariants && section.selectedCta !== undefined
        && section.ctaVariants[section.selectedCta] !== section.ctaText) {
        delete section.selectedCta
      }
      return section
    })
}

/** Landing-page form fields (used by the public submit endpoint). */
export function wizardFieldsToLandingFormFields(fields: WizardFormField[] | undefined) {
  return (fields || []).map((f) => {
    const id = String(f.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    return { id, name: id, label: f.label, type: f.type, required: !!f.required }
  })
}
