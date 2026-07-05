import type {
  PageType,
  SubType,
  Framework,
  SectionType,
  SectionDefinition,
  OfferQuestion,
  ToneId,
} from './types'

// ---------------------------------------------------------------------------
// Page Types
// ---------------------------------------------------------------------------

export interface PageTypeOption {
  id: PageType
  label: string
  description: string
  iconName: string
  category?: 'funnel'
}

export const PAGE_TYPES: PageTypeOption[] = [
  {
    id: 'capture-leads',
    label: 'Capture Leads',
    description: 'Collect emails with a free resource, newsletter, or waitlist',
    iconName: 'Mail',
  },
  {
    id: 'book-a-call',
    label: 'Book a Call',
    description: 'Get prospects to schedule a call or consultation',
    iconName: 'Phone',
  },
  {
    id: 'sell-digital',
    label: 'Sell a Digital Product',
    description: 'Courses, ebooks, templates, software, or memberships',
    iconName: 'Download',
  },
  {
    id: 'sell-physical',
    label: 'Sell a Physical Product',
    description: 'Showcase and sell a physical product or collection',
    iconName: 'Package',
  },
  {
    id: 'sell-service',
    label: 'Sell a Service',
    description: 'Coaching, agency work, freelance, or consulting',
    iconName: 'Briefcase',
  },
  {
    id: 'promote-event',
    label: 'Promote an Event',
    description: 'Webinars, workshops, conferences, or meetups',
    iconName: 'CalendarDays',
  },
  {
    id: 'general',
    label: 'Custom Page',
    description: 'Describe what you need and we\'ll build it',
    iconName: 'PenLine',
  },
  // Funnel page types
  {
    id: 'upsell',
    label: 'Upsell Offer',
    description: 'Post-purchase offer to increase order value',
    iconName: 'ArrowUpCircle',
    category: 'funnel',
  },
  {
    id: 'downsell',
    label: 'Downsell Offer',
    description: 'Reduced offer for customers who declined the upsell',
    iconName: 'ArrowDownCircle',
    category: 'funnel',
  },
  {
    id: 'funnel-checkout',
    label: 'Checkout Page',
    description: 'Branded checkout page with trust signals',
    iconName: 'CreditCard',
    category: 'funnel',
  },
] as PageTypeOption[]

// ---------------------------------------------------------------------------
// Sub-Types
// ---------------------------------------------------------------------------

export interface SubTypeOption {
  id: SubType
  label: string
  description: string
}

export const SUB_TYPES: Record<PageType, SubTypeOption[]> = {
  'capture-leads': [
    { id: 'free-guide', label: 'Free Guide', description: 'PDF, ebook, or downloadable resource' },
    { id: 'checklist', label: 'Checklist', description: 'Step-by-step checklist or cheat sheet' },
    { id: 'newsletter', label: 'Newsletter', description: 'Recurring email newsletter signup' },
    { id: 'waitlist', label: 'Waitlist', description: 'Early access or launch waitlist' },
    { id: 'free-trial', label: 'Free Trial', description: 'Try before you buy' },
  ],
  'book-a-call': [
    { id: 'discovery-call', label: 'Free Discovery Call', description: 'No-cost introductory call' },
    { id: 'strategy-session', label: 'Strategy Session', description: 'In-depth strategy planning' },
    { id: 'demo-request', label: 'Demo Request', description: 'Product or service demo' },
  ],
  'sell-digital': [
    { id: 'course', label: 'Course', description: 'Online course or training program' },
    { id: 'ebook', label: 'Ebook', description: 'Digital book or written guide' },
    { id: 'template-pack', label: 'Template Pack', description: 'Templates, swipe files, or kits' },
    { id: 'software-saas', label: 'Software / SaaS', description: 'Software product or subscription' },
    { id: 'membership', label: 'Membership', description: 'Recurring membership or community' },
  ],
  'sell-physical': [
    { id: 'single-product', label: 'Single Product', description: 'One featured product' },
    { id: 'collection', label: 'Collection', description: 'Product line or curated collection' },
  ],
  'sell-service': [
    { id: 'coaching', label: 'Coaching', description: '1-on-1 or group coaching' },
    { id: 'agency', label: 'Agency', description: 'Agency services or packages' },
    { id: 'freelance', label: 'Freelance', description: 'Freelance or contract work' },
    { id: 'consulting', label: 'Consulting', description: 'Expert consulting services' },
  ],
  'promote-event': [
    { id: 'webinar', label: 'Webinar', description: 'Online presentation or webinar' },
    { id: 'workshop', label: 'Workshop', description: 'Hands-on workshop or class' },
    { id: 'conference', label: 'Conference', description: 'Multi-session conference' },
    { id: 'meetup', label: 'Meetup', description: 'Casual meetup or networking event' },
  ],
  general: [
    { id: 'general', label: 'General Page', description: 'Flexible page — you decide the structure' },
  ],
  upsell: [
    { id: 'premium-upgrade', label: 'Premium Upgrade', description: 'Upgrade to a premium version or plan' },
    { id: 'bundle-offer', label: 'Bundle Offer', description: 'Bundle of complementary products or services' },
    { id: 'add-on', label: 'Add-On', description: 'Additional feature, service, or resource' },
  ],
  downsell: [
    { id: 'lite-version', label: 'Lite Version', description: 'Stripped-down version at a lower price' },
    { id: 'starter-pack', label: 'Starter Pack', description: 'Essential resources at a reduced price' },
    { id: 'payment-plan', label: 'Payment Plan', description: 'Same offer split into installments' },
  ],
  'funnel-checkout': [
    { id: 'standard-checkout', label: 'Standard Checkout', description: 'Clean checkout with product summary' },
  ],
}

// ---------------------------------------------------------------------------
// Tone Options
// ---------------------------------------------------------------------------

export interface ToneOption {
  id: ToneId
  label: string
  description: string
}

export const TONE_OPTIONS: ToneOption[] = [
  { id: 'professional', label: 'Professional', description: 'Polished and authoritative' },
  { id: 'casual', label: 'Casual', description: 'Relaxed and approachable' },
  { id: 'bold', label: 'Bold', description: 'Confident and high-energy' },
  { id: 'friendly', label: 'Friendly', description: 'Warm and encouraging' },
  { id: 'direct-response', label: 'Direct Response', description: 'Urgency-driven, conversion-focused' },
  { id: 'custom', label: 'Custom', description: 'Describe your own tone' },
]

// ---------------------------------------------------------------------------
// Framework → Section Mappings
// ---------------------------------------------------------------------------

export const FRAMEWORK_SECTIONS: Record<Framework, SectionType[]> = {
  PAS: ['hero', 'pain-points', 'features-benefits', 'testimonials', 'faq', 'cta-block'],
  AIDA: ['hero', 'logo-bar', 'features-benefits', 'how-it-works', 'testimonials', 'offer-breakdown', 'value-stack', 'faq', 'cta-block'],
  PASTOR: ['hero', 'pain-points', 'story-narrative', 'before-after', 'features-benefits', 'how-it-works', 'testimonials', 'offer-breakdown', 'value-stack', 'who-its-for', 'faq', 'two-futures-close'],
  BAB: ['hero', 'before-after', 'features-benefits', 'how-it-works', 'testimonials', 'faq', 'cta-block'],
}

// ---------------------------------------------------------------------------
// Section Definitions
// ---------------------------------------------------------------------------

export const SECTION_DEFINITIONS: Record<SectionType, SectionDefinition> = {
  hero: {
    type: 'hero',
    label: 'Hero',
    icon: 'Layout',
    fields: [
      { key: 'headline', label: 'Headline', type: 'text', required: true },
      { key: 'subtitle', label: 'Subtitle', type: 'textarea' },
      { key: 'ctaText', label: 'Button Text', type: 'cta', required: true },
    ],
  },
  'pain-points': {
    type: 'pain-points',
    label: 'Pain Points',
    icon: 'AlertTriangle',
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'items', label: 'Pain Points', type: 'items' },
    ],
  },
  'features-benefits': {
    type: 'features-benefits',
    label: 'Features & Benefits',
    icon: 'Sparkles',
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'items', label: 'Features', type: 'items' },
    ],
  },
  'how-it-works': {
    type: 'how-it-works',
    label: 'How It Works',
    icon: 'Cog',
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'items', label: 'Steps', type: 'items' },
    ],
  },
  testimonials: {
    type: 'testimonials',
    label: 'Testimonials',
    icon: 'MessageSquare',
    optional: true,
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'items', label: 'Testimonials', type: 'items' },
    ],
  },
  'logo-bar': {
    type: 'logo-bar',
    label: 'Trust Badges',
    icon: 'Building2',
    optional: true,
    fields: [
      { key: 'headline', label: 'Label', type: 'text', placeholder: 'Trusted by leading companies' },
      { key: 'items', label: 'Company Names', type: 'items' },
    ],
  },
  'story-narrative': {
    type: 'story-narrative',
    label: 'Your Story',
    icon: 'BookOpen',
    optional: true,
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'body', label: 'Story', type: 'textarea' },
    ],
  },
  'before-after': {
    type: 'before-after',
    label: 'Before & After',
    icon: 'ArrowRightLeft',
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'beforeText', label: 'Before (Current Pain)', type: 'textarea' },
      { key: 'afterText', label: 'After (Desired Outcome)', type: 'textarea' },
    ],
  },
  'offer-breakdown': {
    type: 'offer-breakdown',
    label: 'What You Get',
    icon: 'Gift',
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'items', label: 'Included Items', type: 'items' },
    ],
  },
  pricing: {
    type: 'pricing',
    label: 'Pricing',
    icon: 'DollarSign',
    optional: true,
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'price', label: 'Price', type: 'text' },
      { key: 'priceNote', label: 'Price Note', type: 'text', placeholder: 'One-time payment' },
      { key: 'guaranteeText', label: 'Guarantee', type: 'text', placeholder: '30-day money-back guarantee' },
      { key: 'ctaText', label: 'Button Text', type: 'cta' },
    ],
  },
  faq: {
    type: 'faq',
    label: 'FAQ',
    icon: 'HelpCircle',
    optional: true,
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'faqItems', label: 'Questions', type: 'items' },
    ],
  },
  'cta-block': {
    type: 'cta-block',
    label: 'Final CTA',
    icon: 'Target',
    fields: [
      { key: 'headline', label: 'Headline', type: 'text' },
      { key: 'subtitle', label: 'Subtitle', type: 'textarea' },
      { key: 'ctaText', label: 'Button Text', type: 'cta', required: true },
    ],
  },
  'value-stack': {
    type: 'value-stack',
    label: 'Value & Pricing',
    icon: 'DollarSign',
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'valueItems', label: 'What\'s Included (with values)', type: 'items' },
      { key: 'totalValue', label: 'Total Value', type: 'text' },
      { key: 'price', label: 'Actual Price', type: 'text' },
      { key: 'paymentPlan', label: 'Payment Plan', type: 'text' },
      { key: 'guaranteeText', label: 'Guarantee', type: 'text' },
      { key: 'ctaText', label: 'Button Text', type: 'cta', required: true },
    ],
  },
  'who-its-for': {
    type: 'who-its-for',
    label: 'Who It\'s For',
    icon: 'Target',
    fields: [
      { key: 'headline', label: 'Section Headline', type: 'text' },
      { key: 'forItems', label: 'This is for you if...', type: 'items' },
      { key: 'notForItems', label: 'This is NOT for you if...', type: 'items' },
    ],
  },
  'two-futures-close': {
    type: 'two-futures-close',
    label: 'Closing CTA',
    icon: 'Target',
    fields: [
      { key: 'headline', label: 'Headline', type: 'text' },
      { key: 'inactionText', label: 'Path A (if they don\'t act)', type: 'textarea' },
      { key: 'actionText', label: 'Path B (if they act)', type: 'textarea' },
      { key: 'ctaText', label: 'Button Text', type: 'cta', required: true },
      { key: 'guaranteeText', label: 'Guarantee reminder', type: 'text' },
    ],
  },
}

// ---------------------------------------------------------------------------
// Offer Questions — Deep questions per page type / sub-type
// ---------------------------------------------------------------------------

const SHARED_QUESTIONS: OfferQuestion[] = [
  { key: 'offerName', label: 'What is the name of your offer?', placeholder: 'e.g., The Ultimate Marketing Playbook', inputType: 'text' },
  { key: 'problem', label: 'What problem does this solve?', placeholder: 'e.g., Struggling to get consistent leads online', inputType: 'textarea', required: true },
]

const PRICE_QUESTION: OfferQuestion = {
  key: 'price', label: 'What is the price?', placeholder: 'e.g., $49, Free, $99/month', inputType: 'text',
}

const GUARANTEE_QUESTION: OfferQuestion = {
  key: 'guarantee', label: 'Do you offer a guarantee?', placeholder: 'e.g., 30-day money-back guarantee', inputType: 'text',
}

const WHATS_INCLUDED: OfferQuestion = {
  key: 'whatsIncluded', label: 'What is included?', placeholder: 'List the main components (one per line)', inputType: 'textarea',
}

const SOCIAL_PROOF: OfferQuestion = {
  key: 'socialProof', label: 'Any results, testimonials, or numbers to share?', placeholder: 'e.g., "Helped 500+ students land their first client"', inputType: 'textarea',
}

export const OFFER_QUESTIONS: Record<PageType, Record<string, OfferQuestion[]>> = {
  'capture-leads': {
    'free-guide': [
      ...SHARED_QUESTIONS,
      { key: 'description', label: 'Describe this lead magnet', placeholder: 'What is it, what format (PDF, video, etc.), and what will people learn or get from it?', inputType: 'textarea', required: true },
      SOCIAL_PROOF,
    ],
    checklist: [
      ...SHARED_QUESTIONS,
      { key: 'description', label: 'Describe this checklist', placeholder: 'What does it cover? How many steps? What will someone be able to do after completing it?', inputType: 'textarea', required: true },
      SOCIAL_PROOF,
    ],
    newsletter: [
      ...SHARED_QUESTIONS,
      { key: 'description', label: 'Describe your newsletter', placeholder: 'What topics do you cover? How often do you send? What makes it worth subscribing to?', inputType: 'textarea', required: true },
      SOCIAL_PROOF,
    ],
    waitlist: [
      ...SHARED_QUESTIONS,
      { key: 'launchDate', label: 'When does it launch?', placeholder: 'e.g., Q2 2026, June 15', inputType: 'text' },
      { key: 'earlyAccess', label: 'What do early members get?', placeholder: 'e.g., Founding member pricing, early access, bonus content', inputType: 'textarea' },
    ],
    'free-trial': [
      ...SHARED_QUESTIONS,
      { key: 'trialLength', label: 'How long is the trial?', placeholder: 'e.g., 14 days', inputType: 'text' },
      { key: 'whatTheyGet', label: 'What do they get access to?', placeholder: 'e.g., All premium features, unlimited projects', inputType: 'textarea' },
      SOCIAL_PROOF,
    ],
  },
  'book-a-call': {
    'discovery-call': [
      ...SHARED_QUESTIONS,
      { key: 'duration', label: 'How long is the call?', placeholder: 'e.g., 30 minutes', inputType: 'text' },
      { key: 'whatTheyLearn', label: 'What will they walk away with?', placeholder: 'e.g., A clear roadmap for their next 90 days', inputType: 'textarea' },
      { key: 'credentials', label: 'Why should they trust you?', placeholder: 'e.g., 10+ years experience, worked with 200+ clients', inputType: 'textarea' },
    ],
    'paid-consultation': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'duration', label: 'How long is the session?', placeholder: 'e.g., 60 minutes', inputType: 'text' },
      { key: 'deliverables', label: 'What do they get after the call?', placeholder: 'e.g., Recorded session, action plan document, follow-up email', inputType: 'textarea' },
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
    'strategy-session': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'duration', label: 'How long is the session?', placeholder: 'e.g., 90 minutes', inputType: 'text' },
      { key: 'whatTheyCover', label: 'What topics do you cover?', placeholder: 'e.g., Marketing strategy, sales funnel audit, growth roadmap', inputType: 'textarea' },
      SOCIAL_PROOF,
    ],
    'demo-request': [
      ...SHARED_QUESTIONS,
      { key: 'duration', label: 'How long is the demo?', placeholder: 'e.g., 20 minutes', inputType: 'text' },
      { key: 'keyFeatures', label: 'Top features you will show?', placeholder: 'e.g., Dashboard, automation, reporting', inputType: 'textarea' },
      SOCIAL_PROOF,
    ],
  },
  'sell-digital': {
    course: [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'studentOutcome', label: 'What will students be able to do after?', placeholder: 'e.g., Build and launch a profitable online store', inputType: 'textarea', required: true },
      WHATS_INCLUDED,
      { key: 'format', label: 'Course format?', placeholder: 'e.g., 12 video modules, worksheets, private community', inputType: 'textarea' },
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
    ebook: [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'pageCount', label: 'How long is it?', placeholder: 'e.g., 120 pages', inputType: 'text' },
      { key: 'whatTheyLearn', label: 'Key takeaways?', placeholder: 'List 3-5 things readers will learn', inputType: 'textarea' },
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
    'template-pack': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'numTemplates', label: 'How many templates?', placeholder: 'e.g., 25 templates', inputType: 'text' },
      WHATS_INCLUDED,
      { key: 'compatibility', label: 'Compatible with?', placeholder: 'e.g., Figma, Notion, Google Docs', inputType: 'text' },
      SOCIAL_PROOF,
    ],
    'software-saas': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'keyFeatures', label: 'Top 3-5 features?', placeholder: 'One feature per line', inputType: 'textarea', required: true },
      { key: 'integrations', label: 'Key integrations?', placeholder: 'e.g., Slack, Zapier, Google Sheets', inputType: 'text' },
      SOCIAL_PROOF,
    ],
    membership: [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      WHATS_INCLUDED,
      { key: 'communitySize', label: 'Community size or details?', placeholder: 'e.g., 500+ active members, weekly live calls', inputType: 'textarea' },
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
  },
  'sell-physical': {
    'single-product': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'keyFeatures', label: 'Key features or specs?', placeholder: 'List the standout features', inputType: 'textarea', required: true },
      { key: 'materials', label: 'Materials or quality details?', placeholder: 'e.g., Premium leather, handcrafted, organic cotton', inputType: 'textarea' },
      { key: 'shipping', label: 'Shipping info?', placeholder: 'e.g., Free shipping, ships in 2-3 days', inputType: 'text' },
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
    collection: [
      ...SHARED_QUESTIONS,
      { key: 'priceRange', label: 'Price range?', placeholder: 'e.g., $29 - $149', inputType: 'text' },
      { key: 'numProducts', label: 'How many products?', placeholder: 'e.g., 8 products', inputType: 'text' },
      { key: 'unifyingTheme', label: 'What ties the collection together?', placeholder: 'e.g., Minimalist home office essentials', inputType: 'textarea' },
      SOCIAL_PROOF,
    ],
  },
  'sell-service': {
    coaching: [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'format', label: 'Coaching format?', placeholder: 'e.g., Weekly 1-on-1 calls, group sessions, Voxer access', inputType: 'textarea' },
      { key: 'duration', label: 'Program length?', placeholder: 'e.g., 12 weeks, 6 months, ongoing', inputType: 'text' },
      { key: 'transformation', label: 'What transformation do clients experience?', placeholder: 'Describe the before → after', inputType: 'textarea', required: true },
      { key: 'credentials', label: 'Your credentials or experience?', placeholder: 'e.g., Certified coach, 500+ clients, featured in Forbes', inputType: 'textarea' },
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
    agency: [
      ...SHARED_QUESTIONS,
      { key: 'services', label: 'Services you offer?', placeholder: 'List your main services', inputType: 'textarea', required: true },
      { key: 'process', label: 'Your process (3-4 steps)?', placeholder: 'e.g., 1. Discovery call 2. Strategy 3. Execution 4. Reporting', inputType: 'textarea' },
      { key: 'credentials', label: 'Notable clients or results?', placeholder: 'e.g., Worked with 50+ startups, $10M+ in client revenue', inputType: 'textarea' },
      SOCIAL_PROOF,
    ],
    freelance: [
      ...SHARED_QUESTIONS,
      { key: 'services', label: 'What do you do?', placeholder: 'e.g., Brand design, copywriting, web development', inputType: 'textarea', required: true },
      { key: 'turnaround', label: 'Typical turnaround time?', placeholder: 'e.g., 1-2 weeks', inputType: 'text' },
      { key: 'credentials', label: 'Your background?', placeholder: 'e.g., 8 years experience, worked with Shopify, Nike, etc.', inputType: 'textarea' },
      SOCIAL_PROOF,
    ],
    consulting: [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'expertise', label: 'Your area of expertise?', placeholder: 'e.g., Revenue operations, growth strategy, market entry', inputType: 'textarea', required: true },
      { key: 'deliverables', label: 'What do clients receive?', placeholder: 'e.g., Audit report, strategy doc, implementation roadmap', inputType: 'textarea' },
      { key: 'credentials', label: 'Credentials and track record?', placeholder: 'e.g., Ex-McKinsey, 15 years in SaaS, advisory board member', inputType: 'textarea' },
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
  },
  'promote-event': {
    webinar: [
      ...SHARED_QUESTIONS,
      { key: 'date', label: 'Date and time?', placeholder: 'e.g., April 15, 2026 at 2pm EST', inputType: 'text', required: true },
      { key: 'duration', label: 'How long?', placeholder: 'e.g., 60 minutes', inputType: 'text' },
      { key: 'whatTheyLearn', label: 'What will attendees learn? (3-5 bullets)', placeholder: 'One topic per line', inputType: 'textarea', required: true },
      { key: 'speaker', label: 'Who is presenting?', placeholder: 'Name, title, and brief bio', inputType: 'textarea' },
      SOCIAL_PROOF,
    ],
    workshop: [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'date', label: 'Date and time?', placeholder: 'e.g., April 20-21, 2026', inputType: 'text', required: true },
      { key: 'duration', label: 'How long?', placeholder: 'e.g., 2 half-days, 4 hours', inputType: 'text' },
      { key: 'whatTheyBuild', label: 'What will participants walk away with?', placeholder: 'e.g., A finished portfolio site, a 90-day marketing plan', inputType: 'textarea', required: true },
      { key: 'spots', label: 'Limited spots?', placeholder: 'e.g., 20 seats only', inputType: 'text' },
      SOCIAL_PROOF,
    ],
    conference: [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'date', label: 'Date?', placeholder: 'e.g., May 10-12, 2026', inputType: 'text', required: true },
      { key: 'location', label: 'Location?', placeholder: 'e.g., Austin, TX or Virtual', inputType: 'text', required: true },
      { key: 'speakers', label: 'Notable speakers?', placeholder: 'Names and titles', inputType: 'textarea' },
      { key: 'tracks', label: 'Topics or tracks?', placeholder: 'e.g., Growth, Product, Engineering, Design', inputType: 'textarea' },
      SOCIAL_PROOF,
    ],
    meetup: [
      ...SHARED_QUESTIONS,
      { key: 'date', label: 'Date and time?', placeholder: 'e.g., Every first Thursday at 6pm', inputType: 'text', required: true },
      { key: 'location', label: 'Where?', placeholder: 'e.g., WeWork Downtown, Austin TX', inputType: 'text', required: true },
      { key: 'agenda', label: 'What happens at the meetup?', placeholder: 'e.g., Networking, lightning talks, drinks', inputType: 'textarea' },
      SOCIAL_PROOF,
    ],
  },
  general: {
    general: [
      ...SHARED_QUESTIONS,
      { key: 'additionalInfo', label: 'Any other details the page should include?', placeholder: 'Describe what you want on the page', inputType: 'textarea' },
      SOCIAL_PROOF,
    ],
  },
  upsell: {
    'premium-upgrade': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'originalProduct', label: 'What did they just buy?', placeholder: 'e.g., The Basic Marketing Course', inputType: 'text', required: true },
      WHATS_INCLUDED,
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
    'bundle-offer': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'originalProduct', label: 'What did they just buy?', placeholder: 'e.g., The Starter Kit', inputType: 'text', required: true },
      WHATS_INCLUDED,
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
    'add-on': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'originalProduct', label: 'What did they just buy?', placeholder: 'e.g., The Core Platform', inputType: 'text', required: true },
      WHATS_INCLUDED,
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
  },
  downsell: {
    'lite-version': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'originalOffer', label: 'What upsell did they decline?', placeholder: 'e.g., The Premium Bundle at $297', inputType: 'text', required: true },
      WHATS_INCLUDED,
      GUARANTEE_QUESTION,
    ],
    'starter-pack': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'originalOffer', label: 'What upsell did they decline?', placeholder: 'e.g., The Full Course at $497', inputType: 'text', required: true },
      WHATS_INCLUDED,
      GUARANTEE_QUESTION,
    ],
    'payment-plan': [
      ...SHARED_QUESTIONS,
      PRICE_QUESTION,
      { key: 'originalOffer', label: 'What upsell did they decline?', placeholder: 'e.g., The Annual Plan at $997', inputType: 'text', required: true },
      { key: 'paymentTerms', label: 'Payment plan details?', placeholder: 'e.g., 3 monthly payments of $99', inputType: 'text', required: true },
      GUARANTEE_QUESTION,
    ],
  },
  'funnel-checkout': {
    'standard-checkout': [
      { key: 'offerName', label: 'Product name', placeholder: 'e.g., The Marketing Masterclass', inputType: 'text' },
      { key: 'problem', label: 'Why should they complete the purchase?', placeholder: 'Reinforce the value — what they get and why it matters', inputType: 'textarea', required: true },
      GUARANTEE_QUESTION,
      SOCIAL_PROOF,
    ],
  },
}

// ---------------------------------------------------------------------------
// Base copywriting craft rules — injected into every AI copy call
// (generation AND refinement) so edits don't drift back to generic copy
// ---------------------------------------------------------------------------

export const BASE_CRAFT_RULES = `- No generic filler. Every sentence must be specific to this business and audience.
- BANNED phrases, never write any of these: "in today's world", "in today's fast-paced world", "take it to the next level", "unlock your potential", "it's important to", "game-changer", "look no further".
- The hero headline must contain a specific number or a concrete object/outcome the reader can picture (e.g., "Fill your calendar with 10 qualified calls a month"). Never write abstract headlines like "Transform your business".
- Every bullet and item description must state what the reader will be able to DO after saying yes: a concrete action or result, not an abstract quality.
- CTAs must name the specific thing the reader gets (e.g., "Get the 12-point checklist", "Book my 30-minute audit"). Never use generic CTAs like "Get started", "Learn more", or "Submit".
- Headlines must be benefit-driven — lead with what the reader gains.
- CTAs must be action-oriented. First-person preferred ("Get my..." not "Get your...").
- Never use em dashes anywhere. Use periods, commas, or restructure.
- Read-aloud test: if a line would sound off spoken to a customer's face, rewrite it.
- Vary sentence length. A short sentence after two long ones lands harder.
- Match the requested tone throughout all copy.`

// ---------------------------------------------------------------------------
// Quality-bar exemplars per page type — shown to the AI as the expected
// caliber of headlines and CTAs (never copied verbatim into output)
// ---------------------------------------------------------------------------

export const COPY_EXEMPLARS: Record<PageType, { headlines: string[]; ctas: string[] }> = {
  'capture-leads': {
    headlines: [
      'The 12-Point Checklist That Catches the Mistakes Costing You Bookings',
      'Write a Week of Social Posts in 45 Minutes (Free Template Inside)',
      '27 Subject Lines That Earned 40%+ Open Rates. Steal Them.',
    ],
    ctas: ['Send me the 12-point checklist', 'Get the free template', 'Steal the 27 subject lines'],
  },
  'book-a-call': {
    headlines: [
      'Walk Away With a 90-Day Growth Plan in One Free 30-Minute Call',
      'Find the 3 Leaks in Your Sales Process. Free 20-Minute Audit.',
      'In 30 Minutes, Know Exactly What Your Website Should Say',
    ],
    ctas: ['Book my free 30-minute call', 'Claim my 20-minute audit', 'Pick a time that works for me'],
  },
  'sell-digital': {
    headlines: [
      'Launch Your First Paid Course in 6 Weeks, Even With Zero Audience',
      'The 25-Template Kit That Turns a Blank Page Into a Finished Proposal in 20 Minutes',
      'Go From Inbox Chaos to a 4-Hour-a-Week Admin System',
    ],
    ctas: ['Get instant access to all 25 templates', 'Enroll in the 6-week program', 'Start module 1 today'],
  },
  'sell-physical': {
    headlines: [
      'The 1.2 lb Carry-On Organizer That Ends Repacking Forever',
      'Brew Cafe-Grade Espresso at Home in Under 4 Minutes',
      'One Desk Mat. Zero Cable Clutter. 10 Seconds to a Clean Workspace.',
    ],
    ctas: ['Add the organizer to my cart', 'Order mine, ships in 2 days', 'Get the starter bundle'],
  },
  'sell-service': {
    headlines: [
      'We Build and Run Your Ad Funnel. You Just Take the Sales Calls.',
      'Your Books Closed by the 5th of Every Month, Guaranteed',
      'A Conversion-Ready Website Live in 21 Days',
    ],
    ctas: ['Get my 21-day build plan', 'Book a 15-minute scoping call', 'See packages and pricing'],
  },
  'promote-event': {
    headlines: [
      'Build Your 2027 Content Calendar Live in This 90-Minute Workshop',
      'Watch Us Audit 5 Real Landing Pages, Live on June 24',
      'Leave With a Finished Pitch Deck: A Hands-On Half-Day Workshop',
    ],
    ctas: ['Save my seat for June 24', 'Register free, 200 spots', 'Reserve my workshop spot'],
  },
  general: {
    headlines: [
      'Everything You Need to Switch Accountants in 14 Days',
      'See Exactly How the Program Works: Curriculum, Pricing, and Dates',
      'The Straight Answer to "What Does It Cost?"',
    ],
    ctas: ['Show me the 14-day switch plan', 'Download the full curriculum', 'Get exact pricing'],
  },
  upsell: {
    headlines: [
      'Add the Done-For-You Template Library and Skip 20 Hours of Setup',
      'Upgrade to Lifetime Access for $40 More, on This Page Only',
      'You Have the Plan. Add the Weekly Coaching That Makes It Stick.',
    ],
    ctas: ['Yes, add it to my order', 'Upgrade my order for $40', 'Add lifetime access'],
  },
  downsell: {
    headlines: [
      'Not Ready for the Full Program? Start With the 5 Core Modules for $49',
      'Keep the Coaching, Split the Cost: 3 Payments of $99',
      'The Starter Version: Same System, First 30 Days Only',
    ],
    ctas: ['Start with the 5 core modules', 'Switch to 3 payments of $99', 'Get the starter version'],
  },
  'funnel-checkout': {
    headlines: [
      "You're One Step From the Full 12-Module Program",
      'Complete Your Order. Instant Access the Moment You Pay.',
      'Almost There: Your Templates Are Waiting on the Other Side',
    ],
    ctas: ['Complete my order', 'Pay securely and get instant access', 'Finish checkout'],
  },
}

// ---------------------------------------------------------------------------
// Default form fields by page type
// ---------------------------------------------------------------------------

export const DEFAULT_FORM_FIELDS: Record<PageType, { label: string; type: string; required: boolean }[]> = {
  'capture-leads': [
    { label: 'Name', type: 'text', required: false },
    { label: 'Email', type: 'email', required: true },
  ],
  'book-a-call': [
    { label: 'Name', type: 'text', required: true },
    { label: 'Email', type: 'email', required: true },
    { label: 'Phone', type: 'tel', required: false },
    { label: 'Message', type: 'textarea', required: false },
  ],
  'sell-digital': [
    { label: 'Email', type: 'email', required: true },
  ],
  'sell-physical': [
    { label: 'Email', type: 'email', required: true },
  ],
  'sell-service': [
    { label: 'Name', type: 'text', required: true },
    { label: 'Email', type: 'email', required: true },
    { label: 'Company', type: 'text', required: false },
    { label: 'Message', type: 'textarea', required: false },
  ],
  'promote-event': [
    { label: 'Name', type: 'text', required: true },
    { label: 'Email', type: 'email', required: true },
  ],
  general: [
    { label: 'Name', type: 'text', required: true },
    { label: 'Email', type: 'email', required: true },
    { label: 'Message', type: 'textarea', required: false },
  ],
  upsell: [],
  downsell: [],
  'funnel-checkout': [
    { label: 'Name', type: 'text', required: true },
    { label: 'Email', type: 'email', required: true },
  ],
}
