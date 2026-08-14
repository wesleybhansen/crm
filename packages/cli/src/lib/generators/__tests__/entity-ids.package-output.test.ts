import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PackageResolver } from '../../resolver'
import { generateEntityIds } from '../entity-ids'

describe('entity-id package output', () => {
  it('includes disabled package modules only in package output and app modules in app output', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-ids-package-output-'))
    const appDir = path.join(rootDir, 'apps', 'mercato')
    const coreDir = path.join(rootDir, 'packages', 'core')
    const appOutput = path.join(appDir, '.mercato', 'generated')
    const coreOutput = path.join(coreDir, 'generated')

    fs.mkdirSync(path.join(coreDir, 'src', 'modules', 'auth', 'data'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(coreDir, 'src', 'modules', 'catalog', 'data'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(appDir, 'src', 'modules', 'example', 'data'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(coreDir, 'src', 'modules', 'auth', 'data', 'entities.ts'),
      'export class User { id!: string }\n',
    )
    fs.writeFileSync(
      path.join(coreDir, 'src', 'modules', 'catalog', 'data', 'entities.ts'),
      'export class CatalogProduct { id!: string }\n',
    )
    fs.writeFileSync(
      path.join(appDir, 'src', 'modules', 'example', 'data', 'entities.ts'),
      'export class ExampleTodo { id!: string }\n',
    )

    const resolver: PackageResolver = {
      isMonorepo: () => true,
      getRootDir: () => rootDir,
      getAppDir: () => appDir,
      getOutputDir: () => appOutput,
      getModulesConfigPath: () => path.join(appDir, 'src', 'modules.ts'),
      discoverPackages: () => [
        {
          name: '@open-mercato/core',
          path: coreDir,
          modulesPath: path.join(coreDir, 'src', 'modules'),
        },
      ],
      loadEnabledModules: () => [{ id: 'auth', from: '@open-mercato/core' }],
      getModulePaths: (entry) => ({
        appBase: path.join(appDir, 'src', 'modules', entry.id),
        pkgBase: path.join(coreDir, 'src', 'modules', entry.id),
      }),
      getModuleImportBase: (entry) => ({
        appBase: `@/modules/${entry.id}`,
        pkgBase: `@open-mercato/core/modules/${entry.id}`,
      }),
      getPackageOutputDir: (packageName) => (packageName === '@app' ? appOutput : coreOutput),
      getPackageRoot: () => coreDir,
    }

    try {
      await generateEntityIds({ resolver, quiet: true })

      const appIds = fs.readFileSync(path.join(appOutput, 'entities.ids.generated.ts'), 'utf8')
      const coreIds = fs.readFileSync(path.join(coreOutput, 'entities.ids.generated.ts'), 'utf8')

      expect(appIds).toContain('"auth"')
      expect(appIds).not.toContain('"catalog"')
      expect(appIds).toContain('"example"')
      expect(appIds).toContain('"example_todo": "example:example_todo"')
      expect(coreIds).toContain('"auth"')
      expect(coreIds).toContain('"catalog"')
      expect(coreIds).toContain('"catalog_product": "catalog:catalog_product"')
      expect(fs.existsSync(path.join(coreOutput, 'entities', 'catalog_product', 'index.ts'))).toBe(true)
      expect(fs.existsSync(path.join(appOutput, 'entities', 'catalog_product', 'index.ts'))).toBe(false)
      expect(fs.existsSync(path.join(appOutput, 'entities', 'example_todo', 'index.ts'))).toBe(true)
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
