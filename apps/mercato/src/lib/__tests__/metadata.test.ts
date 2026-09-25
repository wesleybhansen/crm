jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ t: (_key: string, fallback: string) => fallback }),
}))

import { resolveLocalizedTitleMetadata } from '../metadata'

describe('resolveLocalizedTitleMetadata', () => {
  it('returns the route title so the backend template renders "<Page> | Noli CRM"', async () => {
    await expect(resolveLocalizedTitleMetadata({ title: 'Affiliates' })).resolves.toEqual({ title: 'Affiliates' })
  })

  it('leaves the title to the layout when the route has none', async () => {
    await expect(resolveLocalizedTitleMetadata({})).resolves.toEqual({})
    await expect(resolveLocalizedTitleMetadata({ title: null, titleKey: null })).resolves.toEqual({})
  })

  it('still honours an explicit fallback', async () => {
    await expect(resolveLocalizedTitleMetadata({ fallback: 'Forms' })).resolves.toEqual({ title: 'Forms' })
  })
})
