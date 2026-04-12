import type { SearchModuleConfig, SearchBuildContext, SearchResultPresenter, SearchIndexSource } from '@open-mercato/shared/modules/search'

function pick(...c: unknown[]): string | null { for (const v of c) { if (typeof v === 'string' && v.trim()) return v.trim() } return null }
function buildSource(ctx: SearchBuildContext, p: SearchResultPresenter, lines: string[]): SearchIndexSource | null { return lines.length ? { text: lines, presenter: p, checksumSource: { record: ctx.record, customFields: ctx.customFields } } : null }

export const searchConfig: SearchModuleConfig = {
  entities: [
    {
      entityId: 'landing_pages:landing_page',
      enabled: true, priority: 5,
      buildSource: async (ctx) => { const r = ctx.record; const l: string[] = []; if (r.title) l.push(`Title: ${r.title}`); if (r.slug) l.push(`Slug: ${r.slug}`); return buildSource(ctx, { title: pick(r.title) || 'Landing Page', subtitle: `/${r.slug || ''}`, icon: 'globe', badge: 'Landing Page' }, l) },
      formatResult: async (ctx) => ({ title: pick(ctx.record.title) || 'Landing Page', subtitle: `/${ctx.record.slug || ''}`, icon: 'globe', badge: 'Landing Page' }),
      resolveUrl: async (ctx) => `/backend/landing-pages/edit?id=${encodeURIComponent(String(ctx.record.id))}`,
      fieldPolicy: { searchable: ['title', 'slug'] },
    },
    {
      entityId: 'landing_pages:funnel',
      enabled: true, priority: 4,
      buildSource: async (ctx) => { const r = ctx.record; const l: string[] = []; if (r.name) l.push(`Name: ${r.name}`); if (r.slug) l.push(`Slug: ${r.slug}`); return buildSource(ctx, { title: pick(r.name) || 'Funnel', subtitle: r.is_published ? 'Published' : 'Draft', icon: 'trending-up', badge: 'Funnel' }, l) },
      formatResult: async (ctx) => ({ title: pick(ctx.record.name) || 'Funnel', subtitle: ctx.record.is_published ? 'Published' : 'Draft', icon: 'trending-up', badge: 'Funnel' }),
      resolveUrl: async () => '/backend/funnels',
      fieldPolicy: { searchable: ['name', 'slug'] },
    },
  ],
}

export { searchConfig as config }
export default searchConfig
