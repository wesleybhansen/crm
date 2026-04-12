import type { SearchModuleConfig, SearchBuildContext, SearchResultPresenter, SearchIndexSource } from '@open-mercato/shared/modules/search'

function pick(...candidates: unknown[]): string | null {
  for (const c of candidates) { if (typeof c === 'string' && c.trim()) return c.trim() }
  return null
}

function buildSource(ctx: SearchBuildContext, presenter: SearchResultPresenter, lines: string[]): SearchIndexSource | null {
  if (!lines.length) return null
  return { text: lines, presenter, checksumSource: { record: ctx.record, customFields: ctx.customFields } }
}

export const searchConfig: SearchModuleConfig = {
  entities: [
    {
      entityId: 'email:email_campaign',
      enabled: true,
      priority: 5,
      buildSource: async (ctx) => {
        const r = ctx.record
        const lines: string[] = []
        if (r.name) lines.push(`Name: ${r.name}`)
        if (r.subject) lines.push(`Subject: ${r.subject}`)
        if (r.category) lines.push(`Category: ${r.category}`)
        return buildSource(ctx, { title: pick(r.name) || 'Blast', subtitle: pick(r.subject, r.status) || '', icon: 'mail', badge: 'Blast' }, lines)
      },
      formatResult: async (ctx) => ({ title: pick(ctx.record.name) || 'Blast', subtitle: pick(ctx.record.subject, ctx.record.status) || '', icon: 'mail', badge: 'Blast' }),
      resolveUrl: async () => '/backend/email-marketing',
      fieldPolicy: { searchable: ['name', 'subject', 'category'] },
    },
    {
      entityId: 'email:email_list',
      enabled: true,
      priority: 5,
      buildSource: async (ctx) => {
        const r = ctx.record
        const lines: string[] = []
        if (r.name) lines.push(`Name: ${r.name}`)
        if (r.description) lines.push(`Description: ${r.description}`)
        return buildSource(ctx, { title: pick(r.name) || 'List', subtitle: `${r.member_count || 0} members`, icon: 'users', badge: 'Email List' }, lines)
      },
      formatResult: async (ctx) => ({ title: pick(ctx.record.name) || 'List', subtitle: `${ctx.record.member_count || 0} members`, icon: 'users', badge: 'Email List' }),
      resolveUrl: async () => '/backend/email-marketing',
      fieldPolicy: { searchable: ['name', 'description'] },
    },
    {
      entityId: 'email:email_style_template',
      enabled: true,
      priority: 3,
      buildSource: async (ctx) => {
        const r = ctx.record
        const lines: string[] = []
        if (r.name) lines.push(`Name: ${r.name}`)
        if (r.category) lines.push(`Category: ${r.category}`)
        return buildSource(ctx, { title: pick(r.name) || 'Template', subtitle: pick(r.category) || 'general', icon: 'layout', badge: 'Template' }, lines)
      },
      formatResult: async (ctx) => ({ title: pick(ctx.record.name) || 'Template', subtitle: pick(ctx.record.category) || 'general', icon: 'layout', badge: 'Template' }),
      resolveUrl: async () => '/backend/email-marketing',
      fieldPolicy: { searchable: ['name', 'category'] },
    },
  ],
}


export { searchConfig as config }
export default searchConfig
