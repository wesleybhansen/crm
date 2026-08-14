'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { ArrowRight, PenLine } from 'lucide-react'
import { SUB_TYPES, PAGE_TYPES } from '../constants'
import type { WizardActions } from '../hooks/useWizardState'
import type { SubType } from '../types'

interface Props {
  wizard: WizardActions
}

export function Step2SubType({ wizard }: Props) {
  const { state } = wizard
  const pageType = state.pageType
  const [customDescription, setCustomDescription] = useState('')
  const [showCustom, setShowCustom] = useState(false)

  const options = useMemo(() => pageType ? SUB_TYPES[pageType] || [] : [], [pageType])
  const pageLabel = PAGE_TYPES.find((p) => p.id === pageType)?.label || ''

  // If only one subtype (e.g., general), auto-advance via effect
  const shouldAutoAdvance = options.length === 1 && !showCustom
  useEffect(() => {
    if (shouldAutoAdvance) {
      wizard.setSubType(options[0].id as SubType)
    }
  }, [shouldAutoAdvance, options, wizard])

  if (!pageType) return null

  // Show a brief loading state instead of null to prevent layout flicker
  if (shouldAutoAdvance) {
    return (
      <div className="max-w-[520px] mx-auto px-6 py-20 text-center">
        <p className="text-sm text-muted-foreground">Setting up your page...</p>
      </div>
    )
  }

  const handleCustomContinue = () => {
    if (!customDescription.trim()) return
    wizard.setOfferAnswer('customDescription', customDescription)
    // Use 'general' subtype for custom descriptions — the custom description
    // in offerAnswers will guide AI generation instead of subtype-specific questions
    const generalOption = options.find((o) => o.id === 'general')
    wizard.setSubType((generalOption?.id || options[0].id) as SubType)
  }

  if (showCustom) {
    return (
      <div className="max-w-[520px] mx-auto px-6 py-12">
        <h1 className="text-xl font-semibold mb-1 text-center">
          Describe your page
        </h1>
        <p className="text-sm text-muted-foreground text-center mb-6">
          Tell us what this page is for and we'll tailor the copy to match.
        </p>
        <textarea
          value={customDescription}
          onChange={(e) => setCustomDescription(e.target.value)}
          placeholder={`Describe your ${pageLabel.toLowerCase()} page. What are you offering? Who is it for?`}
          rows={4}
          autoFocus
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        />
        <div className="flex justify-between mt-4">
          <Button variant="ghost" size="sm" onClick={() => setShowCustom(false)}>
            Back to options
          </Button>
          <Button onClick={handleCustomContinue} disabled={!customDescription.trim()} className="gap-1.5">
            Continue <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[640px] mx-auto px-6 py-12">
      <h1 className="text-xl font-semibold mb-1 text-center">
        What kind of {pageLabel.toLowerCase()} page?
      </h1>
      <p className="text-sm text-muted-foreground text-center mb-8">
        The more specific, the better the AI-generated copy.
      </p>

      <div className="grid grid-cols-2 gap-3">
        {options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => wizard.setSubType(opt.id as SubType)}
            className="flex flex-col gap-1 rounded border border-border bg-card p-3 text-left transition-colors cursor-pointer hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <span className="text-sm font-medium">{opt.label}</span>
            <span className="text-xs text-muted-foreground leading-snug">
              {opt.description}
            </span>
          </button>
        ))}

        {/* Custom option */}
        <button
          onClick={() => setShowCustom(true)}
          className="flex items-center gap-3 rounded border border-border bg-card p-3 text-left transition-colors cursor-pointer hover:border-accent/50"
        >
          <PenLine className="size-4 text-muted-foreground shrink-0" />
          <div>
            <span className="text-sm font-medium block">Something else</span>
            <span className="text-xs text-muted-foreground">Describe it yourself</span>
          </div>
        </button>
      </div>
    </div>
  )
}
