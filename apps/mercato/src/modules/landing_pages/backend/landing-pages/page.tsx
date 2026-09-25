'use client'

import { useState, useEffect, useCallback } from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { translateWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, Globe, Eye, FileText, Trash2, ExternalLink, ToggleLeft, ToggleRight, Pencil, Download } from 'lucide-react'
import { plural } from '../../lib/plural'

type LandingPage = {
  id: string
  title: string
  slug: string
  status: string
  template_id: string | null
  template_category: string | null
  view_count: number
  submission_count: number
  created_at: string
  published_at: string | null
}

export default function LandingPagesListPage() {
  const t = useT()
  const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback)

  const [pages, setPages] = useState<LandingPage[]>([])
  const [loading, setLoading] = useState(true)

  const loadPages = useCallback(() => {
    fetch('/api/landing_pages/pages')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setPages(d.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { loadPages() }, [loadPages])

  async function togglePublish(page: LandingPage, e: React.MouseEvent) {
    e.stopPropagation()
    const newStatus = page.status === 'published' ? 'draft' : 'published'
    try {
      const res = await fetch(`/api/landing_pages/pages/${page.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const data = await res.json()
      if (data.ok) loadPages()
      else alert(data.error || 'Failed to update')
    } catch { alert('Failed to update') }
  }

  async function deletePage(page: LandingPage, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`Delete "${page.title}"?`)) return
    try {
      await fetch(`/api/landing_pages/pages/${page.id}`, { method: 'DELETE' })
      loadPages()
    } catch { alert('Failed to delete') }
  }

  const statusColors: Record<string, string> = {
    draft: 'bg-[rgba(16,16,18,.07)] text-[rgba(16,16,18,.62)] border-[rgba(16,16,18,.16)] dark:bg-[rgba(255,255,255,.10)] dark:text-[rgba(255,255,255,.6)] dark:border-[rgba(255,255,255,.14)]',
    published: 'bg-[rgba(16,185,129,.10)] text-[#047857] border-[rgba(16,185,129,.26)] dark:bg-[rgba(16,185,129,.14)] dark:text-[#34d399] dark:border-[rgba(16,185,129,.30)]',
    archived: 'bg-[rgba(239,68,68,.10)] text-[#b91c1c] border-[rgba(239,68,68,.24)] dark:bg-[rgba(239,68,68,.13)] dark:text-[#f87171] dark:border-[rgba(239,68,68,.30)]',
  }

  function statusBadge(page: LandingPage) {
    return (
      <span className={`inline-flex h-[21px] items-center px-2 rounded-full border font-mono text-[10px] font-semibold uppercase tracking-[.07em] ${statusColors[page.status] || 'bg-[rgba(16,16,18,.07)] text-[rgba(16,16,18,.62)] border-[rgba(16,16,18,.16)] dark:bg-[rgba(255,255,255,.10)] dark:text-[rgba(255,255,255,.6)] dark:border-[rgba(255,255,255,.14)]'}`}>
        {page.status === 'published' && <Globe className="size-3 mr-1" />}
        {page.status}
      </span>
    )
  }

  function conversionLabel(page: LandingPage) {
    return page.view_count > 0 ? `${((page.submission_count / page.view_count) * 100).toFixed(1)}%` : '—'
  }

  // `touch`: the phone card layout, with 40px tap targets.
  function renderActions(page: LandingPage, touch: boolean) {
    return (
      <div className={touch ? 'flex flex-wrap items-center gap-1' : 'flex items-center justify-end gap-1'}>
        <IconButton
          variant="ghost"
          size="sm"
          className={touch ? 'size-10' : undefined}
          type="button"
          aria-label={page.status === 'published' ? 'Unpublish' : 'Publish'}
          onClick={(e) => togglePublish(page, e)}
        >
          {page.status === 'published' ? <ToggleRight className="size-4 text-[#047857] dark:text-[#34d399]" /> : <ToggleLeft className="size-4" />}
        </IconButton>
        <IconButton
          variant="ghost"
          size="sm"
          className={touch ? 'size-10' : undefined}
          type="button"
          aria-label="Edit page"
          onClick={() => window.location.href = `/backend/landing-pages/edit?id=${page.id}`}
        >
          <Pencil className="size-4" />
        </IconButton>
        {page.status === 'published' && (
          <IconButton
            variant="ghost"
            size="sm"
          className={touch ? 'size-10' : undefined}
            type="button"
            aria-label="View live page"
            onClick={(e) => { e.stopPropagation(); window.open(`/api/landing_pages/public/${page.slug}`, '_blank') }}
          >
            <ExternalLink className="size-4" />
          </IconButton>
        )}
        {page.status === 'published' && (
          <IconButton
            variant="ghost"
            size="sm"
          className={touch ? 'size-10' : undefined}
            type="button"
            aria-label="Download HTML"
            onClick={async (e) => {
              e.stopPropagation()
              try {
                const res = await fetch(`/api/landing_pages/public/${page.slug}`)
                if (!res.ok) { alert('Page not available for download'); return }
                const html = await res.text()
                const blob = new Blob([html], { type: 'text/html' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = page.slug + '.html'
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)
              } catch { alert('Download failed') }
            }}
          >
            <Download className="size-4" />
          </IconButton>
        )}
        <IconButton
          variant="ghost"
          size="sm"
          className={touch ? 'size-10' : undefined}
          type="button"
          aria-label="Delete"
          onClick={(e) => deletePage(page, e)}
        >
          <Trash2 className="size-4" />
        </IconButton>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">{translate('landing_pages.list.title', 'Landing Pages')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{plural(pages.length, 'page')}</p>
        </div>
        <Button type="button" onClick={() => window.location.href = '/backend/landing-pages/create'}>
          <Plus className="size-4 mr-2" /> {translate('landing_pages.list.actions.create', 'New Page')}
        </Button>
      </div>

      {loading ? (
        <div className="text-muted-foreground text-sm">Loading...</div>
      ) : pages.length === 0 ? (
        <div className="rounded-lg border p-12 text-center">
          <FileText className="size-10 mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-muted-foreground">{translate('landing_pages.list.empty', 'No landing pages yet. Create your first page to start capturing leads.')}</p>
          <Button type="button" className="mt-4" onClick={() => window.location.href = '/backend/landing-pages/create'}>
            <Plus className="size-4 mr-2" /> Create your first page
          </Button>
        </div>
      ) : (
        <>
          {/* Phone: one card per page (the table is wider than a phone). */}
          <ul className="md:hidden flex flex-col gap-3">
            {pages.map((page) => (
              <li key={page.id} className="rounded-lg border p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium text-sm break-words min-w-0">{page.title}</p>
                  {statusBadge(page)}
                </div>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {plural(page.view_count, 'view')} · {plural(page.submission_count, 'lead')} · {conversionLabel(page)} conv.
                </p>
                <div className="mt-2 -ml-2">{renderActions(page, true)}</div>
              </li>
            ))}
          </ul>

          <div className="hidden md:block rounded-lg border overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Title</th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Status</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Views</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Leads</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Conv.</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((page) => (
                <tr key={page.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium text-sm">{page.title}</td>
                  <td className="px-4 py-3">{statusBadge(page)}</td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums">{page.view_count}</td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums">{page.submission_count}</td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums">{conversionLabel(page)}</td>
                  <td className="px-4 py-3 text-right">{renderActions(page, false)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </div>
  )
}
