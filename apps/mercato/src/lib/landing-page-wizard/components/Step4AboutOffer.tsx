'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { ArrowRight, ExternalLink } from 'lucide-react'
import { OFFER_QUESTIONS, SUB_TYPES } from '../constants'
import type { WizardActions } from '../hooks/useWizardState'

interface Props {
  wizard: WizardActions
}

interface Product {
  id: string
  name: string
  price: number | null
  currency: string
  billing_type: string
  product_type: string
}

export function Step4AboutOffer({ wizard }: Props) {
  const { state, setOfferAnswer, nextStep, updateFrameworkFromPrice, setBookingPage, setProduct } = wizard
  const { pageType, subType, businessContext } = state

  const [bookingPages, setBookingPages] = useState<{ id: string; title: string; slug: string }[]>([])
  const [loadingBookings, setLoadingBookings] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [loadingProducts, setLoadingProducts] = useState(false)

  const isBookingPage = pageType === 'book-a-call'
  const isSellPage = pageType === 'sell-digital' || pageType === 'sell-physical' || pageType === 'sell-service'

  // Fetch booking pages (for book-a-call)
  useEffect(() => {
    if (!isBookingPage) return
    setLoadingBookings(true)
    fetch('/api/calendar/booking-pages', { credentials: 'include' })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok && Array.isArray(res.data)) {
          setBookingPages(res.data.map((bp: any) => ({ id: bp.id, title: bp.title, slug: bp.slug })))
        }
      })
      .catch(() => {})
      .finally(() => setLoadingBookings(false))
  }, [isBookingPage])

  // Fetch products + courses (for sell pages)
  useEffect(() => {
    if (!isSellPage) return
    setLoadingProducts(true)

    const fetchProducts = fetch('/api/payments/products', { credentials: 'include' })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok && Array.isArray(res.data)) {
          const typeMap: Record<string, string[]> = {
            'sell-digital': ['digital'],
            'sell-physical': ['physical'],
            'sell-service': ['service'],
          }
          const allowedTypes = typeMap[pageType!] || []
          const filtered = res.data.filter((p: any) =>
            p.is_active !== false && (allowedTypes.length === 0 || allowedTypes.includes(p.product_type))
          )
          return filtered.length > 0 ? filtered : res.data.filter((p: any) => p.is_active !== false)
        }
        return []
      })
      .catch(() => [] as Product[])

    const fetchCourses = fetch('/api/courses/courses', { credentials: 'include' })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok && Array.isArray(res.data)) {
          return res.data
            .filter((c: any) => c.is_published && !c.is_free && c.price)
            .map((c: any): Product => ({
              id: `course:${c.id}`,
              name: c.title,
              price: c.price,
              currency: c.currency || 'USD',
              billing_type: 'one_time',
              product_type: 'course',
            }))
        }
        return []
      })
      .catch(() => [] as Product[])

    Promise.all([fetchProducts, fetchCourses]).then(([prods, courses]) => {
      setProducts([...prods, ...courses])
    }).finally(() => setLoadingProducts(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSellPage])

  if (!pageType || !subType) return null

  const allQuestions = OFFER_QUESTIONS[pageType]?.[subType] || OFFER_QUESTIONS.general.general
  const subTypeLabel = SUB_TYPES[pageType]?.find((s) => s.id === subType)?.label || ''
  const SKIP_KEYS = new Set(['mainBenefit', 'whatTheyLearn', 'whatTheyGet'])
  const questions = allQuestions.filter((q) => !SKIP_KEYS.has(q.key))

  const canProceed = questions
    .filter((q) => q.required && q.key !== 'offerName')
    .every((q) => businessContext.offerAnswers[q.key]?.trim())
    && (!isBookingPage || state.bookingPageSlug)

  const handleNext = () => {
    updateFrameworkFromPrice()
    nextStep()
  }

  const formatPrice = (p: Product) => {
    const amount = p.price ? `$${Number(p.price).toFixed(2)}` : 'No price set'
    const suffix = p.billing_type === 'recurring' ? '/mo' : ''
    const tag = p.product_type === 'course' ? ' (Course)' : ''
    return `${amount}${suffix}${tag}`
  }

  return (
    <div className="max-w-[520px] mx-auto px-6 py-12">
      <h1 className="text-xl font-semibold mb-1 text-center">
        Tell us about your {subTypeLabel.toLowerCase()}
      </h1>
      <p className="text-sm text-muted-foreground text-center mb-8">
        The more detail you provide, the better your AI-generated copy will be.
      </p>

      <div className="flex flex-col gap-5">
        {/* Booking page picker (for book-a-call) */}
        {isBookingPage && (
          <div>
            <label className="text-sm font-medium block mb-1.5">
              Which booking page should visitors use?
            </label>
            {loadingBookings ? (
              <p className="text-xs text-muted-foreground">Loading booking pages...</p>
            ) : bookingPages.length > 0 ? (
              <select
                value={state.bookingPageSlug || ''}
                onChange={(e) => setBookingPage(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="">Select a booking page...</option>
                {bookingPages.map((bp) => (
                  <option key={bp.id} value={bp.slug}>{bp.title}</option>
                ))}
              </select>
            ) : (
              <div className="rounded border border-dashed border-border p-4 text-center">
                <p className="text-sm text-muted-foreground mb-2">No booking pages found. Create one first.</p>
                <a href="/backend/calendar" target="_blank" className="text-sm text-accent hover:underline inline-flex items-center gap-1">
                  Go to Calendar <ExternalLink className="size-3" />
                </a>
              </div>
            )}
          </div>
        )}

        {/* Product picker (for sell pages) */}
        {isSellPage && (
          <div>
            <label className="text-sm font-medium block mb-1.5">
              Which product or service is this page for?
            </label>
            {loadingProducts ? (
              <p className="text-xs text-muted-foreground">Loading products...</p>
            ) : products.length > 0 ? (
              <select
                value={state.productId || ''}
                onChange={(e) => setProduct(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="">Select a product or service...</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatPrice(p)}
                  </option>
                ))}
              </select>
            ) : (
              <div className="rounded border border-dashed border-border p-4 text-center">
                <p className="text-sm text-muted-foreground mb-2">No products found. Create one in Payments first.</p>
                <a href="/backend/payments" target="_blank" className="text-sm text-accent hover:underline inline-flex items-center gap-1">
                  Go to Payments <ExternalLink className="size-3" />
                </a>
              </div>
            )}
            {state.productId && (
              <p className="text-xs text-muted-foreground mt-1">
                The page's buy button will link to a checkout page for this product.
              </p>
            )}
          </div>
        )}

        {/* Offer questions */}
        {questions.map((q) => {
          const isOptional = q.key === 'offerName' || !q.required
          return (
            <div key={q.key}>
              <label className="text-sm font-medium block mb-1.5">
                {q.label}
                {isOptional && <span className="text-muted-foreground font-normal ml-1">(optional)</span>}
              </label>

              {q.inputType === 'textarea' ? (
                <textarea
                  value={businessContext.offerAnswers[q.key] || ''}
                  onChange={(e) => setOfferAnswer(q.key, e.target.value)}
                  placeholder={q.placeholder}
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                />
              ) : q.inputType === 'select' && q.options ? (
                <select
                  value={businessContext.offerAnswers[q.key] || ''}
                  onChange={(e) => setOfferAnswer(q.key, e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                >
                  <option value="">Select...</option>
                  {q.options.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : (
                <Input
                  type={q.inputType === 'number' ? 'number' : 'text'}
                  value={businessContext.offerAnswers[q.key] || ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOfferAnswer(q.key, e.target.value)}
                  placeholder={q.placeholder}
                />
              )}
            </div>
          )
        })}

        <div className="flex justify-end mt-2">
          <Button onClick={handleNext} disabled={!canProceed} className="gap-1.5">
            Continue
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
