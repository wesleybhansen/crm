import type { SearchModuleConfig, SearchBuildContext, SearchResultPresenter, SearchIndexSource } from '@open-mercato/shared/modules/search'

function pick(...c: unknown[]): string | null { for (const v of c) { if (typeof v === 'string' && v.trim()) return v.trim() } return null }
function buildSource(ctx: SearchBuildContext, p: SearchResultPresenter, lines: string[]): SearchIndexSource | null { return lines.length ? { text: lines, presenter: p, checksumSource: { record: ctx.record, customFields: ctx.customFields } } : null }

export const searchConfig: SearchModuleConfig = {
  entities: [
    {
      entityId: 'calendar:booking_page',
      enabled: true, priority: 5,
      buildSource: async (ctx) => { const r = ctx.record; const l: string[] = []; if (r.title) l.push(`Title: ${r.title}`); if (r.description) l.push(`Description: ${r.description}`); return buildSource(ctx, { title: pick(r.title) || 'Booking Page', subtitle: `${r.duration_minutes || 30}min`, icon: 'calendar', badge: 'Booking Page' }, l) },
      formatResult: async (ctx) => ({ title: pick(ctx.record.title) || 'Booking Page', subtitle: `${ctx.record.duration_minutes || 30}min`, icon: 'calendar', badge: 'Booking Page' }),
      resolveUrl: async () => '/backend/calendar',
      fieldPolicy: { searchable: ['title', 'description', 'slug'] },
    },
  ],
}

export { searchConfig as config }
export default searchConfig
