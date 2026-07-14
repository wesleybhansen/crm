export type PageType =
  | 'capture-leads'
  | 'book-a-call'
  | 'sell-digital'
  | 'sell-physical'
  | 'sell-service'
  | 'promote-event'
  | 'case-study'
  | 'comparison'
  | 'general'
  | 'upsell'
  | 'downsell'
  | 'funnel-checkout'

export type SubType =
  // Capture Leads
  | 'free-guide'
  | 'checklist'
  | 'newsletter'
  | 'waitlist'
  | 'free-trial'
  // Book a Call
  | 'discovery-call'
  | 'paid-consultation'
  | 'strategy-session'
  | 'demo-request'
  // Sell Digital
  | 'course'
  | 'ebook'
  | 'template-pack'
  | 'software-saas'
  | 'membership'
  // Sell Physical
  | 'single-product'
  | 'collection'
  // Sell Service
  | 'coaching'
  | 'agency'
  | 'freelance'
  | 'consulting'
  // Promote Event
  | 'webinar'
  | 'workshop'
  | 'conference'
  | 'meetup'
  // Case Study
  | 'client-result'
  | 'transformation-story'
  // Comparison
  | 'vs-competitor'
  | 'vs-old-way'
  // General
  | 'general'
  // Upsell
  | 'premium-upgrade'
  | 'bundle-offer'
  | 'add-on'
  // Downsell
  | 'lite-version'
  | 'starter-pack'
  | 'payment-plan'
  // Funnel Checkout
  | 'standard-checkout'

export type Framework = 'PAS' | 'AIDA' | 'PASTOR' | 'BAB'

export type SectionType =
  | 'hero'
  | 'pain-points'
  | 'features-benefits'
  | 'how-it-works'
  | 'testimonials'
  | 'logo-bar'
  | 'story-narrative'
  | 'value-stack'
  | 'who-its-for'
  | 'two-futures-close'
  | 'before-after'
  | 'offer-breakdown'
  | 'pricing'
  | 'faq'
  | 'cta-block'

export type StyleId = 'bold' | 'minimal' | 'warm' | 'dark' | 'professional' | 'vibrant'

export type ToneId = 'professional' | 'casual' | 'bold' | 'friendly' | 'direct-response' | 'custom'

export interface StyleTokens {
  fontDisplay: string
  fontBody: string
  colorBg: string
  colorSurface: string
  colorText: string
  colorTextMuted: string
  colorAccent: string
  colorAccentHover: string
  colorCta: string
  colorCtaText: string
  colorBorder: string
  borderRadius: string
  borderRadiusLg: string
  containerMax: string
  headlineWeight: string
  shadow: string
  shadowHover: string
  transition: string
}

export interface StyleDefinition {
  id: StyleId
  name: string
  description: string
  tokens: StyleTokens
  googleFontsUrl: string
}

export interface SectionField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'items' | 'cta'
  placeholder?: string
  required?: boolean
}

export interface SectionDefinition {
  type: SectionType
  label: string
  icon: string
  fields: SectionField[]
  optional?: boolean
}

export interface GeneratedSectionItem {
  title: string
  description: string
}

export interface GeneratedSection {
  type: SectionType
  headline?: string
  headlineVariants?: string[]
  selectedHeadline?: number
  subtitle?: string
  body?: string
  items?: GeneratedSectionItem[]
  ctaText?: string
  ctaVariants?: string[]
  selectedCta?: number
  ctaUrl?: string
  question?: string
  answer?: string
  faqItems?: { question: string; answer: string }[]
  beforeText?: string
  afterText?: string
  price?: string
  priceNote?: string
  guaranteeText?: string
  paymentPlan?: string
  totalValue?: string
  // who-its-for
  forItems?: string[]
  notForItems?: string[]
  // two-futures-close
  inactionText?: string
  actionText?: string
  // value-stack items have a value field
  valueItems?: { name: string; description: string; value: string }[]
}

export interface OfferQuestion {
  key: string
  label: string
  placeholder: string
  inputType: 'text' | 'textarea' | 'number' | 'select'
  options?: string[]
  required?: boolean
}

export interface BusinessContext {
  businessName: string
  targetAudience: string
  tone: ToneId
  customTone?: string
  offerAnswers: Record<string, string>
}

export interface LeadMagnetConfig {
  downloadUrl: string
  emailSubject?: string
  emailBody?: string
}

export interface WizardState {
  step: number
  pageType: PageType | null
  subType: SubType | null
  framework: Framework | null
  sections: SectionType[]
  businessContext: BusinessContext
  generatedSections: GeneratedSection[]
  styleId: StyleId | null
  styleVariant: number
  slug: string
  formFields: { label: string; type: string; required: boolean }[]
  metaTitle: string
  metaDescription: string
  thankYouHeadline: string
  thankYouMessage: string
  // CRM integration fields
  pipelineStage: string | null
  bookingPageSlug: string | null
  leadMagnet: LeadMagnetConfig | null
  linkedFormId: string | null
  productId: string | null
  heroImageUrl: string | null
  simpleLayout: boolean
}

export interface GenerateCopyRequest {
  pageType: PageType
  subType: SubType
  framework: Framework
  sections: SectionType[]
  businessContext: BusinessContext
}

export interface GenerateCopyResponse {
  ok: boolean
  data?: {
    sections: GeneratedSection[]
    metaTitle: string
    metaDescription: string
  }
  error?: string
}

export interface RefineSectionRequest {
  section: GeneratedSection
  instruction: string
  businessContext: BusinessContext
}

export interface RefineSectionResponse {
  ok: boolean
  data?: { section: GeneratedSection }
  error?: string
}
