/**
 * Wording for lead-capture pages, keyed by the wizard sub-type.
 *
 * Only the free guide and checklist deliver a file, so only they ask for a
 * download URL and say "download". A waitlist, newsletter or free trial
 * gets its own wording instead of the lead-magnet defaults.
 */

export interface CaptureCopy {
  /** Small label above the hero headline. */
  eyebrow: string
  formTitle: string
  formSub: string
  submitLabel: string
  successHeadline: string
  successMessage: string
  /** True when the page hands over a file (needs a download URL). */
  deliversDownload: boolean
}

const DOWNLOAD_SUB_TYPES = new Set(['free-guide', 'checklist'])

const CAPTURE_COPY: Record<string, CaptureCopy> = {
  'free-guide': {
    eyebrow: 'Free Guide',
    formTitle: 'Get your free copy',
    formSub: "Enter your details and we'll send it straight to your inbox.",
    submitLabel: 'Download Free Guide',
    successHeadline: 'Check your inbox!',
    successMessage: "Your guide is on its way.",
    deliversDownload: true,
  },
  checklist: {
    eyebrow: 'Free Checklist',
    formTitle: 'Get the checklist',
    formSub: "Enter your details and we'll send it straight to your inbox.",
    submitLabel: 'Get the Checklist',
    successHeadline: 'Check your inbox!',
    successMessage: 'Your checklist is on its way.',
    deliversDownload: true,
  },
  newsletter: {
    eyebrow: 'Newsletter',
    formTitle: 'Subscribe',
    formSub: 'Get every new issue straight to your inbox.',
    submitLabel: 'Subscribe',
    successHeadline: "You're subscribed!",
    successMessage: 'Watch your inbox for the next issue.',
    deliversDownload: false,
  },
  waitlist: {
    eyebrow: 'Join the Waitlist',
    formTitle: 'Save your spot',
    formSub: "Join the waitlist and we'll let you know as soon as it's ready.",
    submitLabel: 'Join the Waitlist',
    successHeadline: "You're on the list!",
    successMessage: "We'll email you as soon as it's ready.",
    deliversDownload: false,
  },
  'free-trial': {
    eyebrow: 'Free Trial',
    formTitle: 'Start your free trial',
    formSub: "Enter your details and we'll get you set up.",
    submitLabel: 'Start My Free Trial',
    successHeadline: "You're in!",
    successMessage: "We'll send your access details shortly.",
    deliversDownload: false,
  },
}

const GENERIC_CAPTURE_COPY: CaptureCopy = {
  eyebrow: '',
  formTitle: 'Get started',
  formSub: "Enter your details and we'll be in touch.",
  submitLabel: 'Send It to Me',
  successHeadline: 'Thank you!',
  successMessage: "We'll be in touch soon.",
  deliversDownload: false,
}

const EVENT_FORM_COPY: CaptureCopy = {
  eyebrow: 'Upcoming Event',
  formTitle: 'Save your seat',
  formSub: "Register below and we'll send you the details.",
  submitLabel: 'Register Now',
  successHeadline: "You're registered!",
  successMessage: "We'll email you the details shortly.",
  deliversDownload: false,
}

export function captureCopyFor(subType: string | null | undefined): CaptureCopy {
  return (subType && CAPTURE_COPY[subType]) || GENERIC_CAPTURE_COPY
}

/** Whether the wizard should ask for a download URL for this page. */
export function needsDownloadUrl(pageType: string | null | undefined, subType: string | null | undefined): boolean {
  return pageType === 'capture-leads' && !!subType && DOWNLOAD_SUB_TYPES.has(subType)
}

/** Wording for the hero sign-up card on any page type that shows one. */
export function formCopyFor(pageType: string | null | undefined, subType: string | null | undefined): CaptureCopy {
  if (pageType === 'promote-event') return EVENT_FORM_COPY
  return captureCopyFor(subType)
}

/** Extra prompt rule so the AI writes for the page's real goal. */
export function captureGoalRule(subType: string | null | undefined): string {
  switch (subType) {
    case 'waitlist':
      return '- This page is a WAITLIST for something that is not available yet. Never call it a free resource, guide or download. The call to action is joining the waitlist or getting early access, and the copy says what early members get and when it launches (only if the user said when).'
    case 'newsletter':
      return '- This page signs people up to a NEWSLETTER. Never call it a download or a guide. Say what each issue covers and how often it arrives (only if the user said).'
    case 'free-trial':
      return '- This page starts a FREE TRIAL. Never call it a download or a guide. Say what they can use during the trial and for how long (only if the user said).'
    default:
      return ''
  }
}
