'use client'

import { useState } from 'react'
import { Mail, Phone, Download, Package, Briefcase, CalendarDays, PenLine, ArrowUpCircle, ArrowDownCircle, CreditCard, TrendingUp, GitCompare } from 'lucide-react'
import { PAGE_TYPES } from '../constants'
import type { WizardActions } from '../hooks/useWizardState'
import type { PageType } from '../types'

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Mail, Phone, Download, Package, Briefcase, CalendarDays, PenLine, ArrowUpCircle, ArrowDownCircle, CreditCard, TrendingUp, GitCompare,
}

interface Props {
  wizard: WizardActions
}

export function Step1PageType({ wizard }: Props) {
  const [hovered, setHovered] = useState<string | null>(null)

  const standardTypes = PAGE_TYPES.filter(pt => !pt.category)
  const funnelTypes = PAGE_TYPES.filter(pt => pt.category === 'funnel')

  return (
    <div className="max-w-[640px] mx-auto px-6 py-12">
      <h1 className="text-xl font-semibold mb-1 text-center">
        What type of page are you creating?
      </h1>
      <p className="text-sm text-muted-foreground text-center mb-8">
        This helps us ask the right questions and generate better copy.
      </p>

      <div className="grid grid-cols-2 gap-3">
        {standardTypes.map((pt) => {
          const Icon = ICONS[pt.iconName] || PenLine
          return (
            <button
              key={pt.id}
              onClick={() => wizard.setPageType(pt.id as PageType)}
              onMouseEnter={() => setHovered(pt.id)}
              onMouseLeave={() => setHovered(null)}
              className={[
                'flex items-start gap-3 rounded border bg-card p-3 text-left transition-colors cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                hovered === pt.id ? 'border-accent/50' : 'border-border',
              ].join(' ')}
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Icon className="size-[18px]" />
              </div>
              <div>
                <span className="text-sm font-medium block">{pt.label}</span>
                <span className="text-xs text-muted-foreground leading-snug block mt-0.5">
                  {pt.description}
                </span>
              </div>
            </button>
          )
        })}
      </div>

      {funnelTypes.length > 0 && (
        <>
          <div className="flex items-center gap-3 mt-8 mb-4">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Funnel Pages</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {funnelTypes.map((pt) => {
              const Icon = ICONS[pt.iconName] || PenLine
              return (
                <button
                  key={pt.id}
                  onClick={() => wizard.setPageType(pt.id as PageType)}
                  onMouseEnter={() => setHovered(pt.id)}
                  onMouseLeave={() => setHovered(null)}
                  className={[
                    'flex items-start gap-3 rounded border bg-card p-3 text-left transition-colors cursor-pointer',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    hovered === pt.id ? 'border-accent/50' : 'border-border',
                  ].join(' ')}
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-[18px]" />
                  </div>
                  <div>
                    <span className="text-sm font-medium block">{pt.label}</span>
                    <span className="text-xs text-muted-foreground leading-snug block mt-0.5">
                      {pt.description}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
