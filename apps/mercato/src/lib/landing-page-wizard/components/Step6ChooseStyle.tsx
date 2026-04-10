'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { ArrowRight, Loader2, Check, Eye, X, Monitor, Tablet, Smartphone } from 'lucide-react'
import { STYLES } from '../styles'
import type { WizardActions } from '../hooks/useWizardState'

interface Props {
  wizard: WizardActions
}

type Viewport = 'desktop' | 'tablet' | 'mobile'
const viewportWidths: Record<Viewport, string> = { desktop: '100%', tablet: '768px', mobile: '375px' }

export function Step6ChooseStyle({ wizard }: Props) {
  const { state, setStyle, nextStep } = wizard
  const [previewHtml, setPreviewHtml] = useState<Record<string, string>>({})
  const [expandedStyle, setExpandedStyle] = useState<string | null>(null)
  const [viewport, setViewport] = useState<Viewport>('desktop')

  // Load all previews on mount
  useEffect(() => {
    if (state.generatedSections.length === 0) return
    STYLES.forEach((style) => {
      if (!previewHtml[style.id]) {
        loadPreview(style.id)
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.generatedSections.length])

  const loadPreview = async (styleId: string) => {
    try {
      const res = await fetch('/api/landing_pages/ai/preview-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sections: state.generatedSections,
          styleId,
          businessName: state.businessContext.businessName,
          formFields: state.formFields,
          pageType: state.pageType,
          heroImageUrl: state.heroImageUrl,
          bookingPageSlug: state.bookingPageSlug,
          productId: state.productId,
        }),
      })
      if (!res.ok) return
      const data = await res.json()
      if (data.ok && data.html) {
        const previewReady = data.html.replace('</head>', '<style>.reveal{opacity:1!important;transform:none!important;}</style></head>')
        setPreviewHtml((prev) => ({ ...prev, [styleId]: previewReady }))
      }
    } catch {
      // Preview load failed — style card will keep showing spinner
    }
  }

  const handleSelectAndPreview = (styleId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setStyle(styleId as any)
    setExpandedStyle(styleId)
  }

  return (
    <div className="max-w-[960px] mx-auto px-6 py-8">
      <div className="text-center mb-6">
        <h1 className="text-xl font-semibold mb-1">Choose a visual style</h1>
        <p className="text-sm text-muted-foreground">
          Same content, different look. Pick the style that fits your brand.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {STYLES.map((style) => {
          const isSelected = state.styleId === style.id
          const html = previewHtml[style.id]

          return (
            <div
              key={style.id}
              onClick={() => setStyle(style.id as any)}
              className={[
                'rounded border overflow-hidden text-left transition-all cursor-pointer',
                isSelected
                  ? 'border-accent ring-2 ring-accent/20'
                  : 'border-border hover:border-accent/50',
              ].join(' ')}
            >
              {/* Preview thumbnail */}
              <div className="h-[200px] overflow-hidden relative" style={{ background: style.tokens.colorBg }}>
                {html ? (
                  <iframe
                    srcDoc={html}
                    sandbox="allow-same-origin"
                    style={{
                      width: '1200px',
                      height: '900px',
                      transform: 'scale(0.233)',
                      transformOrigin: 'top left',
                    }}
                    className="pointer-events-none border-none"
                    title={`${style.name} preview`}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                )}

                {isSelected && (
                  <div className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-accent">
                    <Check className="size-3.5 text-white" />
                  </div>
                )}

                {/* Preview button overlay */}
                {html && (
                  <button
                    onClick={(e) => handleSelectAndPreview(style.id, e)}
                    className="absolute bottom-2 right-2 flex items-center gap-1 rounded bg-black/70 px-2 py-1 text-[11px] text-white hover:bg-black/90 transition-colors"
                  >
                    <Eye className="size-3" />
                    Preview
                  </button>
                )}
              </div>

              {/* Style Info */}
              <div className="px-3 py-2.5 border-t border-border">
                <div className="flex items-center gap-2 mb-0.5">
                  <div className="flex gap-1">
                    {[style.tokens.colorBg, style.tokens.colorText, style.tokens.colorAccent, style.tokens.colorCta].map((color, i) => (
                      <div key={i} className="size-3 rounded-full border border-border" style={{ background: color }} />
                    ))}
                  </div>
                  <span className="text-sm font-medium">{style.name}</span>
                </div>
                <p className="text-xs text-muted-foreground leading-snug">{style.description}</p>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end mt-6">
        <Button onClick={nextStep} disabled={!state.styleId} className="gap-1.5">
          Preview & Publish
          <ArrowRight className="size-4" />
        </Button>
      </div>

      {/* Full-page preview modal */}
      {expandedStyle && previewHtml[expandedStyle] && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-card rounded-lg border shadow-xl flex flex-col w-full max-w-[1100px] h-[90vh]">
            {/* Modal header */}
            <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold">
                  {STYLES.find((s) => s.id === expandedStyle)?.name} Preview
                </span>
                <div className="flex gap-1 ml-2">
                  {([
                    { id: 'desktop' as Viewport, icon: Monitor },
                    { id: 'tablet' as Viewport, icon: Tablet },
                    { id: 'mobile' as Viewport, icon: Smartphone },
                  ]).map(({ id, icon: Icon }) => (
                    <button
                      key={id}
                      onClick={() => setViewport(id)}
                      className={[
                        'p-1.5 rounded transition-colors',
                        viewport === id ? 'bg-accent/10 text-accent' : 'text-muted-foreground hover:text-foreground',
                      ].join(' ')}
                    >
                      <Icon className="size-4" />
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => { setExpandedStyle(null); nextStep() }}
                  className="gap-1.5 h-7 text-xs"
                >
                  Use This Style
                  <ArrowRight className="size-3.5" />
                </Button>
                <button
                  onClick={() => setExpandedStyle(null)}
                  className="p-1 rounded hover:bg-muted text-muted-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Preview iframe */}
            <div className="flex-1 overflow-auto bg-muted/30 flex justify-center p-4">
              <div
                className="bg-white rounded-lg border shadow-sm overflow-hidden h-fit"
                style={{ width: viewportWidths[viewport], maxWidth: '100%' }}
              >
                <iframe
                  srcDoc={previewHtml[expandedStyle]}
                  sandbox="allow-same-origin"
                  className="w-full border-none"
                  style={{ height: '800px' }}
                  title="Full preview"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
