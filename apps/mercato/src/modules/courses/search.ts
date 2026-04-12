import type { SearchModuleConfig, SearchBuildContext, SearchResultPresenter, SearchIndexSource } from '@open-mercato/shared/modules/search'

function pick(...c: unknown[]): string | null { for (const v of c) { if (typeof v === 'string' && v.trim()) return v.trim() } return null }
function buildSource(ctx: SearchBuildContext, p: SearchResultPresenter, lines: string[]): SearchIndexSource | null { return lines.length ? { text: lines, presenter: p, checksumSource: { record: ctx.record, customFields: ctx.customFields } } : null }

export const searchConfig: SearchModuleConfig = {
  entities: [
    {
      entityId: 'courses:course',
      enabled: true, priority: 5,
      buildSource: async (ctx) => { const r = ctx.record; const l: string[] = []; if (r.title) l.push(`Title: ${r.title}`); if (r.description) l.push(`Description: ${r.description}`); return buildSource(ctx, { title: pick(r.title) || 'Course', subtitle: r.is_published ? 'Published' : 'Draft', icon: 'book-open', badge: 'Course' }, l) },
      formatResult: async (ctx) => ({ title: pick(ctx.record.title) || 'Course', subtitle: ctx.record.is_published ? 'Published' : 'Draft', icon: 'book-open', badge: 'Course' }),
      resolveUrl: async (ctx) => `/backend/courses/${encodeURIComponent(String(ctx.record.id))}`,
      fieldPolicy: { searchable: ['title', 'description'] },
    },
  ],
}

export { searchConfig as config }
export default searchConfig
