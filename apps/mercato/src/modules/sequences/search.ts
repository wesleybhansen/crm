import type { SearchModuleConfig, SearchBuildContext, SearchResultPresenter, SearchIndexSource } from '@open-mercato/shared/modules/search'

function pick(...c: unknown[]): string | null { for (const v of c) { if (typeof v === 'string' && v.trim()) return v.trim() } return null }
function buildSource(ctx: SearchBuildContext, p: SearchResultPresenter, lines: string[]): SearchIndexSource | null { return lines.length ? { text: lines, presenter: p, checksumSource: { record: ctx.record, customFields: ctx.customFields } } : null }

export const searchConfig: SearchModuleConfig = {
  entities: [
    {
      entityId: 'sequences:sequence',
      enabled: true, priority: 5,
      buildSource: async (ctx) => { const r = ctx.record; const l: string[] = []; if (r.name) l.push(`Name: ${r.name}`); if (r.description) l.push(`Description: ${r.description}`); return buildSource(ctx, { title: pick(r.name) || 'Sequence', subtitle: r.status === 'active' ? 'Active' : 'Draft', icon: 'zap', badge: 'Sequence' }, l) },
      formatResult: async (ctx) => ({ title: pick(ctx.record.name) || 'Sequence', subtitle: ctx.record.status === 'active' ? 'Active' : 'Draft', icon: 'zap', badge: 'Sequence' }),
      resolveUrl: async () => '/backend/email-marketing',
      fieldPolicy: { searchable: ['name', 'description'] },
    },
    {
      entityId: 'sequences:automation_rule',
      enabled: true, priority: 4,
      buildSource: async (ctx) => { const r = ctx.record; const l: string[] = []; if (r.name) l.push(`Name: ${r.name}`); if (r.trigger_type) l.push(`Trigger: ${r.trigger_type}`); if (r.action_type) l.push(`Action: ${r.action_type}`); return buildSource(ctx, { title: pick(r.name) || 'Automation', subtitle: `${r.trigger_type} → ${r.action_type}`, icon: 'settings', badge: 'Automation' }, l) },
      formatResult: async (ctx) => ({ title: pick(ctx.record.name) || 'Automation', subtitle: `${ctx.record.trigger_type || '?'} → ${ctx.record.action_type || '?'}`, icon: 'settings', badge: 'Automation' }),
      resolveUrl: async () => '/backend/automations',
      fieldPolicy: { searchable: ['name', 'trigger_type', 'action_type'] },
    },
  ],
}

export { searchConfig as config }
export default searchConfig
