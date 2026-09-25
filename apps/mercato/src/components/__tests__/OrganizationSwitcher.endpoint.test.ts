/**
 * Regression: the app's organization switcher must load its menu from the
 * scoped core route. A custom `/api/org-switcher` route used to list every
 * organization in the shared Noli tenant to any signed-in member.
 */
import fs from 'node:fs'
import path from 'node:path'

const appSrc = path.resolve(__dirname, '../..')

describe('OrganizationSwitcher endpoint', () => {
  it('fetches the scoped core directory route', () => {
    const source = fs.readFileSync(path.join(appSrc, 'components/OrganizationSwitcher.tsx'), 'utf8')
    expect(source).toContain('/api/directory/organization-switcher')
    expect(source).not.toMatch(/['"`]\/api\/org-switcher/)
  })

  it('has no custom tenant-wide org-switcher route', () => {
    expect(fs.existsSync(path.join(appSrc, 'modules/customers/api/org-switcher'))).toBe(false)
  })
})
