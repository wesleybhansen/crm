import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { RUNTIME_TOOL_TSCONFIG } from '../runtime-tool-compiler'

describe('runtime tool compiler', () => {
  it('preserves legacy decorators without a parent tsconfig', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mercato-runtime-tools-'))
    const entryPath = path.join(directory, 'generated-tools.ts')
    const outputPath = path.join(directory, 'generated-tools.mjs')

    try {
      await writeFile(
        entryPath,
        `
          function legacyMethodDecorator(target: object, propertyKey: string): void {
            if (target.constructor.name !== 'DecoratedTool' || propertyKey !== 'run') {
              throw new Error('legacy decorator contract was not preserved')
            }
          }

          class DecoratedTool {
            @legacyMethodDecorator
            run(): string {
              return 'loaded'
            }
          }

          export const result = new DecoratedTool().run()
        `,
      )

      await build({
        entryPoints: [entryPath],
        outfile: outputPath,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node18',
        tsconfigRaw: RUNTIME_TOOL_TSCONFIG,
      })

      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', 'import(process.env.TEST_RUNTIME_MODULE_URL).then((loaded) => process.stdout.write(loaded.result))'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TEST_RUNTIME_MODULE_URL: pathToFileURL(outputPath).href,
          },
        },
      )

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('loaded')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
