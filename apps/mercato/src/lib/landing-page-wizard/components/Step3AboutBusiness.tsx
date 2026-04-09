'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { ArrowRight } from 'lucide-react'
import { TONE_OPTIONS } from '../constants'
import type { WizardActions } from '../hooks/useWizardState'
import type { ToneId } from '../types'

interface Props {
  wizard: WizardActions
}

export function Step3AboutBusiness({ wizard }: Props) {
  const { state, setBusinessContext, nextStep } = wizard
  const { businessContext } = state
  const [prefilled, setPrefilled] = useState(false)

  // Pre-fill from business profile
  useEffect(() => {
    if (prefilled) return
    setPrefilled(true)
    if (businessContext.businessName) return
    fetch('/api/customers/business-profile', { credentials: 'include' })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok && res.data) {
          const name = res.data.business_name || res.data.name || ''
          if (name) setBusinessContext({ businessName: name })
        }
      })
      .catch(() => {})
  }, [prefilled, businessContext.businessName, setBusinessContext])

  const canProceed = businessContext.businessName.trim() && businessContext.targetAudience.trim()

  return (
    <div className="max-w-[520px] mx-auto px-6 py-12">
      <h1 className="text-xl font-semibold mb-1 text-center">
        Tell us about your business
      </h1>
      <p className="text-sm text-muted-foreground text-center mb-8">
        This context helps the AI write copy that sounds like you.
      </p>

      <div className="flex flex-col gap-5">
        {/* Business Name */}
        <div>
          <label className="text-sm font-medium block mb-1.5">
            Business or Brand Name
          </label>
          <Input
            value={businessContext.businessName}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBusinessContext({ businessName: e.target.value })}
            placeholder="e.g., Acme Coaching"
          />
        </div>

        {/* Target Audience */}
        <div>
          <label className="text-sm font-medium block mb-1.5">
            Who is this page for?
          </label>
          <textarea
            value={businessContext.targetAudience}
            onChange={(e) => setBusinessContext({ targetAudience: e.target.value })}
            placeholder="Describe your ideal customer. e.g., Busy professionals aged 30-50 who want to learn digital marketing but don't know where to start."
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          />
        </div>

        {/* Tone Picker */}
        <div>
          <label className="text-sm font-medium block mb-2">
            What tone should the copy use?
          </label>
          <div className="grid grid-cols-3 gap-2">
            {TONE_OPTIONS.map((tone) => {
              const isSelected = businessContext.tone === tone.id
              return (
                <button
                  key={tone.id}
                  onClick={() => setBusinessContext({ tone: tone.id as ToneId })}
                  className={[
                    'rounded border px-3 py-2.5 text-left transition-colors cursor-pointer',
                    isSelected
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-card hover:border-accent/50',
                  ].join(' ')}
                >
                  <span className="text-sm font-medium block">{tone.label}</span>
                  <span className="text-xs text-muted-foreground leading-snug block mt-0.5">
                    {tone.description}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Custom tone input */}
          {businessContext.tone === 'custom' && (
            <div className="mt-3">
              <Input
                value={businessContext.customTone || ''}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBusinessContext({ customTone: e.target.value })}
                placeholder="Describe your desired tone, e.g., 'Playful but authoritative, like a smart friend'"
              />
            </div>
          )}
        </div>

        {/* Next Button */}
        <div className="flex justify-end mt-2">
          <Button onClick={nextStep} disabled={!canProceed} className="gap-1.5">
            Continue <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
