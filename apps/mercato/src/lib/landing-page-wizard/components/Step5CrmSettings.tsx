'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { ArrowRight, Sparkles, ChevronDown, ChevronUp, Loader2, Link2 } from 'lucide-react'
import { SUB_TYPES } from '../constants'
import type { WizardActions } from '../hooks/useWizardState'
import type { LeadMagnetConfig } from '../types'

interface Props {
  wizard: WizardActions
}

export function Step5CrmSettings({ wizard }: Props) {
  const { state, nextStep, setPipelineStage, setLeadMagnet } = wizard
  const { pageType, subType } = state

  const isLeadCapture = pageType === 'capture-leads'
  const isBookingPage = pageType === 'book-a-call'
  const subTypeLabel = SUB_TYPES[pageType || 'general']?.find((s) => s.id === subType)?.label || 'resource'

  const [pipelineStages, setPipelineStages] = useState<string[]>([])
  const [showInstructions, setShowInstructions] = useState(false)
  const [generatingEmail, setGeneratingEmail] = useState(false)

  // Fetch pipeline stages
  useEffect(() => {
    fetch('/api/customers/business-profile', { credentials: 'include' })
      .then((r) => r.json())
      .then((res) => {
        if (res.ok && res.data?.pipeline_stages) {
          const stages = typeof res.data.pipeline_stages === 'string'
            ? JSON.parse(res.data.pipeline_stages)
            : res.data.pipeline_stages
          if (Array.isArray(stages) && stages.length > 0) {
            setPipelineStages(stages.map((s: any) => typeof s === 'string' ? s : s.name))
            return
          }
        }
        setPipelineStages(['Prospect', 'First Contact', 'Customer', 'Repeat', 'VIP'])
      })
      .catch(() => {
        setPipelineStages(['Prospect', 'First Contact', 'Customer', 'Repeat', 'VIP'])
      })
  }, [])

  // Set default pipeline stage
  useEffect(() => {
    if (!state.pipelineStage && pipelineStages.length > 0) {
      setPipelineStage(pipelineStages[0])
    }
  }, [pipelineStages, state.pipelineStage, setPipelineStage])

  const handleLeadMagnetChange = (field: keyof LeadMagnetConfig, value: string) => {
    setLeadMagnet({
      downloadUrl: state.leadMagnet?.downloadUrl || '',
      emailSubject: state.leadMagnet?.emailSubject,
      emailBody: state.leadMagnet?.emailBody,
      [field]: value,
    })
  }

  const handleGenerateEmailBody = async () => {
    setGeneratingEmail(true)
    try {
      const res = await fetch('/api/landing_pages/ai/refine-section', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          section: {
            type: 'cta-block',
            headline: state.leadMagnet?.emailSubject || `Here's your free ${subTypeLabel}`,
            body: state.leadMagnet?.emailBody || '',
          },
          instruction: `Write a delivery email for someone who just signed up to receive a free ${subTypeLabel} called "${state.businessContext.offerAnswers.offerName || subTypeLabel}". The business is "${state.businessContext.businessName}" targeting "${state.businessContext.targetAudience}". Tone: ${state.businessContext.tone}. Return the headline as a short email subject line (under 50 chars, no quotes). Return the body as the email message (2-3 warm, brief sentences). Do NOT include a download link — that gets added automatically.`,
          businessContext: state.businessContext,
        }),
      })
      const data = await res.json()
      if (data.ok && data.data?.section) {
        const section = data.data.section
        const body = section.body || section.subtitle || ''
        const subject = section.headline || ''
        if (body) {
          setLeadMagnet({
            downloadUrl: state.leadMagnet?.downloadUrl || '',
            emailSubject: subject || state.leadMagnet?.emailSubject,
            emailBody: body,
          })
        }
      }
    } catch {}
    setGeneratingEmail(false)
  }

  const downloadUrl = state.leadMagnet?.downloadUrl?.trim() || ''
  const hasValidUrl = /^https?:\/\/.+/i.test(downloadUrl) || (downloadUrl.includes('.') && downloadUrl.length > 4)
  const hasEmailFields = !!(state.leadMagnet?.emailSubject?.trim()) && !!(state.leadMagnet?.emailBody?.trim())
  const canProceed = isBookingPage || !isLeadCapture || (hasValidUrl && hasEmailFields)

  return (
    <div className="max-w-[520px] mx-auto px-6 py-12">
      <h1 className="text-xl font-semibold mb-1 text-center">
        {isLeadCapture ? 'Delivery & Pipeline' : 'Pipeline Settings'}
      </h1>
      <p className="text-sm text-muted-foreground text-center mb-8">
        {isLeadCapture
          ? 'Set up how your lead magnet gets delivered and where leads land in your pipeline.'
          : 'Choose where new leads from this page land in your pipeline.'}
      </p>

      <div className="flex flex-col gap-6">
        {/* Lead Magnet Delivery (capture-leads only) */}
        {isLeadCapture && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold">Lead Magnet Delivery</h2>
            <p className="text-xs text-muted-foreground -mt-2">
              After someone signs up, they'll be redirected to the download URL and receive a follow-up email with the link.
            </p>

            {/* Download URL */}
            <div>
              <label className="text-sm font-medium block mb-1.5">
                Download URL
              </label>
              <Input
                value={state.leadMagnet?.downloadUrl || ''}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleLeadMagnetChange('downloadUrl', e.target.value)}
                placeholder="https://example.com/your-guide.pdf"
              />

              {/* Collapsible instructions */}
              <button
                onClick={() => setShowInstructions(!showInstructions)}
                className="flex items-center gap-1 mt-2 text-xs text-accent hover:underline"
              >
                <Link2 className="size-3" />
                How do I get a download URL?
                {showInstructions ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              </button>

              {showInstructions && (
                <div className="mt-2 rounded border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-2">
                  <p className="font-medium text-foreground">Option 1: Google Drive</p>
                  <ol className="list-decimal ml-4 space-y-1">
                    <li>Upload your file to Google Drive</li>
                    <li>Right-click the file and select "Share"</li>
                    <li>Set access to "Anyone with the link"</li>
                    <li>Copy the sharing link and paste it above</li>
                  </ol>

                  <p className="font-medium text-foreground pt-2">Option 2: Dropbox</p>
                  <ol className="list-decimal ml-4 space-y-1">
                    <li>Upload your file to Dropbox</li>
                    <li>Click "Share" and copy the link</li>
                    <li>Change <code>?dl=0</code> to <code>?dl=1</code> at the end for a direct download</li>
                  </ol>

                  <p className="font-medium text-foreground pt-2">Option 3: Your own website</p>
                  <ol className="list-decimal ml-4 space-y-1">
                    <li>Upload the file to your website's hosting (e.g., in a <code>/downloads/</code> folder)</li>
                    <li>Use the direct URL, e.g., <code>https://yoursite.com/downloads/guide.pdf</code></li>
                  </ol>

                  <p className="font-medium text-foreground pt-2">Option 4: Other platforms</p>
                  <p>If your content is hosted on another platform, use the public sharing link from that platform.</p>
                </div>
              )}
            </div>

            {/* Write with AI + Email Subject */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium">
                  Email Subject
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleGenerateEmailBody}
                  disabled={generatingEmail}
                  className="h-6 text-xs gap-1 px-2"
                >
                  {generatingEmail
                    ? <><Loader2 className="size-3 animate-spin" /> Generating...</>
                    : <><Sparkles className="size-3" /> Write with AI</>}
                </Button>
              </div>
              <Input
                value={state.leadMagnet?.emailSubject || ''}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleLeadMagnetChange('emailSubject', e.target.value)}
                placeholder={`Here's your free ${subTypeLabel}!`}
              />
            </div>

            {/* Email Body */}
            <div>
              <label className="text-sm font-medium block mb-1.5">
                Email Message
              </label>
              <textarea
                value={state.leadMagnet?.emailBody || ''}
                onChange={(e) => handleLeadMagnetChange('emailBody', e.target.value)}
                placeholder="Thank you for signing up! Click the link below to download your resource."
                rows={4}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              />
            </div>
          </div>
        )}

        {/* Divider (only if both sections shown) */}
        {isLeadCapture && !isBookingPage && (
          <div className="border-t border-border" />
        )}

        {/* Pipeline Stage (all except booking) */}
        {!isBookingPage && pipelineStages.length > 0 && (
          <div>
            <label className="text-sm font-medium block mb-1.5">
              What pipeline stage should new leads land in?
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              When someone submits this page's form, they'll be added to your CRM at this stage.
            </p>
            <select
              value={state.pipelineStage || pipelineStages[0]}
              onChange={(e) => setPipelineStage(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              {pipelineStages.map((stage) => (
                <option key={stage} value={stage}>{stage}</option>
              ))}
            </select>
          </div>
        )}

        <div className="flex justify-center mt-4">
          <Button onClick={nextStep} disabled={!canProceed} className="gap-1.5">
            <Sparkles className="size-4" />
            Generate Copy
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
