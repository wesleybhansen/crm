'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Globe, Monitor, Tablet, Smartphone, Loader2, Check, Sparkles, PanelRightClose, PanelRight, Download } from 'lucide-react'
import type { WizardActions } from '../hooks/useWizardState'

interface Props {
  wizard: WizardActions
}

type Viewport = 'desktop' | 'tablet' | 'mobile'

const viewportWidths: Record<Viewport, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '375px',
}

export function Step7PreviewPublish({ wizard }: Props) {
  const { state, setSlug } = wizard
  const [previewHtml, setPreviewHtml] = useState('')
  const [viewport, setViewport] = useState<Viewport>('desktop')
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)
  const [publishedUrl, setPublishedUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refineInput, setRefineInput] = useState('')
  const [refining, setRefining] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Auto-generate slug from business name
  useEffect(() => {
    if (!state.slug && state.businessContext.businessName) {
      const slug = state.businessContext.businessName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        + '-' + Math.random().toString(36).substring(2, 7)
      setSlug(slug)
    }
  }, [state.slug, state.businessContext.businessName, setSlug])

  // Load preview
  useEffect(() => {
    if (!state.styleId || state.generatedSections.length === 0) return
    loadPreview()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.styleId, state.generatedSections])

  const loadPreview = async () => {
    try {
      const res = await fetch('/api/landing_pages/ai/preview-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sections: state.generatedSections,
          styleId: state.styleId,
          businessName: state.businessContext.businessName,
          formFields: state.formFields,
          pageType: state.pageType,
          heroImageUrl: state.heroImageUrl,
          bookingPageSlug: state.bookingPageSlug,
          productId: state.productId,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.ok && data.html) {
        // Inject style to make reveal animations visible immediately in sandboxed preview
        setPreviewHtml(data.html.replace('</head>', '<style>.reveal{opacity:1!important;transform:none!important;}</style></head>'))
      } else {
        setError(data.error || 'Failed to load preview')
      }
    } catch {
      setError('Failed to load preview — please try again')
    }
  }

  const handleRefine = async () => {
    if (!refineInput.trim()) return
    setRefining(true)
    try {
      const res = await fetch('/api/landing_pages/ai/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          currentHtml: previewHtml,
          feedback: refineInput,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.ok && data.html) {
        setPreviewHtml(data.html.replace('</head>', '<style>.reveal{opacity:1!important;transform:none!important;}</style></head>'))
        setRefineInput('')
      } else {
        setError(data.error || 'Refinement failed')
      }
    } catch {
      setError('AI refinement failed — please try again')
    }
    setRefining(false)
  }

  const handlePublish = async () => {
    if (!state.slug.trim()) return
    setPublishing(true)
    setError(null)

    try {
      const createRes = await fetch('/api/landing_pages/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: state.businessContext.businessName + ' - ' + (state.businessContext.offerAnswers.offerName || 'Landing Page'),
          slug: state.slug,
          config: {
            wizardVersion: 2,
            pageType: state.pageType,
            subType: state.subType,
            framework: state.framework,
            businessContext: state.businessContext,
            generatedSections: state.generatedSections,
            styleId: state.styleId,
            styleVariant: state.styleVariant,
            formFields: state.formFields,
            metaTitle: state.metaTitle,
            metaDescription: state.metaDescription,
            thankYouHeadline: state.thankYouHeadline,
            thankYouMessage: state.thankYouMessage,
            pipelineStage: state.pipelineStage,
            bookingPageSlug: state.bookingPageSlug,
            leadMagnet: state.leadMagnet,
            productId: state.productId,
            heroImageUrl: state.heroImageUrl,
            simpleLayout: state.simpleLayout,
          },
        }),
      })
      const createData = await createRes.json()
      if (!createData.ok) {
        setError(createData.error || 'Failed to create page')
        setPublishing(false)
        return
      }

      const pageId = createData.data?.id
      if (!pageId) {
        setError('Failed to create page — no ID returned')
        setPublishing(false)
        return
      }

      const publishRes = await fetch(`/api/landing_pages/pages/${pageId}/publish`, {
        method: 'POST',
        credentials: 'include',
      })
      const publishData = await publishRes.json()
      if (!publishData.ok) {
        setError(publishData.error || 'Failed to publish')
        setPublishing(false)
        return
      }

      setPublished(true)
      setPublishedUrl(`/api/landing_pages/public/${state.slug}`)
      sessionStorage.removeItem('lp-wizard-state')
    } catch {
      setError('Network error — please try again')
    }
    setPublishing(false)
  }

  const handleDownload = () => {
    if (!previewHtml) return
    // Remove the preview-only reveal override so animations work in the downloaded file
    const cleanHtml = previewHtml.replace('<style>.reveal{opacity:1!important;transform:none!important;}</style>', '')
    const blob = new Blob([cleanHtml], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = (state.slug || 'landing-page') + '.html'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (published) {
    return (
      <div className="max-w-[400px] mx-auto px-6 py-20 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-emerald-500 mx-auto mb-5">
          <Check className="size-7 text-white" />
        </div>
        <h1 className="text-xl font-semibold mb-2">Page Published!</h1>
        <p className="text-sm text-muted-foreground mb-6">Your landing page is now live.</p>
        <div className="flex gap-3 justify-center">
          <Button onClick={() => window.open(publishedUrl, '_blank')} className="gap-1.5">
            <Globe className="size-4" />
            View Live Page
          </Button>
          <Button variant="ghost" onClick={() => window.location.href = '/backend/landing-pages'}>
            Back to Pages
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-120px)]">
      {/* Sidebar */}
      {sidebarOpen && (
        <div className="w-[280px] shrink-0 border-r bg-card flex flex-col overflow-auto">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <h2 className="text-sm font-semibold">Publish Settings</h2>
            <button onClick={() => setSidebarOpen(false)} className="p-1 rounded hover:bg-muted text-muted-foreground">
              <PanelRightClose className="size-4" />
            </button>
          </div>

          <div className="flex-1 p-4 flex flex-col gap-4">
            {/* Slug */}
            <div>
              <label className="text-xs font-medium block mb-1.5">Page URL</label>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">/</span>
                <Input
                  value={state.slug}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  className="text-xs h-8"
                />
              </div>
            </div>

            {/* AI Refine */}
            <div>
              <label className="text-xs font-medium block mb-1.5">Refine with AI</label>
              <textarea
                value={refineInput}
                onChange={(e) => setRefineInput(e.target.value)}
                placeholder="e.g., Make the hero more punchy, change the color scheme to warmer tones, add a countdown feel..."
                rows={6}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefine}
                disabled={refining || !refineInput.trim()}
                className="mt-2 gap-1.5 w-full h-8 text-xs"
              >
                {refining ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                Apply Changes
              </Button>
            </div>

            {/* Viewport Toggle */}
            <div>
              <label className="text-xs font-medium block mb-2">Preview As</label>
              <div className="flex gap-1">
                {([
                  { id: 'desktop' as Viewport, icon: Monitor, label: 'Desktop' },
                  { id: 'tablet' as Viewport, icon: Tablet, label: 'Tablet' },
                  { id: 'mobile' as Viewport, icon: Smartphone, label: 'Mobile' },
                ]).map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    onClick={() => setViewport(id)}
                    className={[
                      'flex-1 flex flex-col items-center gap-1 rounded border py-2 text-xs transition-colors cursor-pointer',
                      viewport === id
                        ? 'border-accent bg-accent/5'
                        : 'border-border hover:border-accent/50',
                    ].join(' ')}
                  >
                    <Icon className="size-4" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          {/* Publish + Download Buttons */}
          <div className="p-4 border-t space-y-2">
            <Button
              onClick={handlePublish}
              disabled={publishing || !state.slug.trim()}
              className="w-full gap-1.5"
            >
              {publishing ? (
                <><Loader2 className="size-4 animate-spin" /> Publishing...</>
              ) : (
                <><Globe className="size-4" /> Publish Page</>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleDownload}
              disabled={!previewHtml}
              className="w-full gap-1.5"
            >
              <Download className="size-4" />
              Download HTML
            </Button>
          </div>
        </div>
      )}

      {/* Preview Area */}
      <div className="flex-1 bg-muted/30 flex flex-col">
        {/* Preview toolbar */}
        {!sidebarOpen && (
          <div className="flex items-center gap-2 px-4 py-2 border-b bg-card">
            <button onClick={() => setSidebarOpen(true)} className="p-1 rounded hover:bg-muted text-muted-foreground">
              <PanelRight className="size-4" />
            </button>
            <span className="text-xs text-muted-foreground">Settings collapsed</span>
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownload}
              disabled={!previewHtml}
              className="h-7 text-xs gap-1.5"
            >
              <Download className="size-3.5" />
              Download
            </Button>
            <Button
              size="sm"
              onClick={handlePublish}
              disabled={publishing || !state.slug.trim()}
              className="h-7 text-xs gap-1.5"
            >
              {publishing ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />}
              Publish
            </Button>
          </div>
        )}

        <div className="flex-1 overflow-auto p-4 flex justify-center">
          <div
            className="bg-white rounded-lg border shadow-sm overflow-hidden h-fit"
            style={{ width: viewportWidths[viewport], maxWidth: '100%' }}
          >
            {previewHtml ? (
              <iframe
                ref={iframeRef}
                srcDoc={previewHtml}
                sandbox="allow-same-origin"
                className="w-full border-none"
                style={{ height: '800px' }}
                title="Page preview"
              />
            ) : (
              <div className="p-20 text-center text-muted-foreground">
                <Loader2 className="size-6 animate-spin mx-auto mb-3" />
                <p className="text-sm">Loading preview...</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
