import type { SearchModuleConfig, SearchBuildContext, SearchResultPresenter, SearchIndexSource } from '@open-mercato/shared/modules/search'

function pick(...c: unknown[]): string | null { for (const v of c) { if (typeof v === 'string' && v.trim()) return v.trim() } return null }
function buildSource(ctx: SearchBuildContext, p: SearchResultPresenter, lines: string[]): SearchIndexSource | null { return lines.length ? { text: lines, presenter: p, checksumSource: { record: ctx.record, customFields: ctx.customFields } } : null }

export const searchConfig: SearchModuleConfig = {
  entities: [
    {
      entityId: 'landing_pages:form',
      enabled: true, priority: 5,
      buildSource: async (ctx) => { const r = ctx.record; const l: string[] = []; if (r.name) l.push(`Name: ${r.name}`); if (r.description) l.push(`Description: ${r.description}`); return buildSource(ctx, { title: pick(r.name) || 'Form', subtitle: `${r.submission_count || 0} submissions`, icon: 'file-text', badge: 'Form' }, l) },
      formatResult: async (ctx) => ({ title: pick(ctx.record.name) || 'Form', subtitle: `${ctx.record.submission_count || 0} submissions`, icon: 'file-text', badge: 'Form' }),
      resolveUrl: async () => '/backend/forms',
      fieldPolicy: { searchable: ['name', 'description', 'slug'] },
    },
  ],
}

export { searchConfig as config }
export default searchConfig
