import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

describe('importRuntimeModule', () => {
  it('loads an ESM file whose URL is only known at runtime', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mercato-runtime-import-'))
    const modulePath = path.join(directory, 'generated-tools.mjs')

    try {
      await writeFile(modulePath, 'export const toolNames = ["customers_create_note"]\n')
      const helperUrl = pathToFileURL(path.resolve(__dirname, '../runtime-module-import.ts')).href
      const script = `
        import { importRuntimeModule } from ${JSON.stringify(helperUrl)}
        const loaded = await importRuntimeModule(process.env.TEST_RUNTIME_MODULE_URL)
        process.stdout.write(JSON.stringify(loaded.toolNames))
      `
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TEST_RUNTIME_MODULE_URL: pathToFileURL(modulePath).href,
          },
        },
      )

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(['customers_create_note'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
