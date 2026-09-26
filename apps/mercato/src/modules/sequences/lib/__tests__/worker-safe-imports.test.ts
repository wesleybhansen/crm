import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * Module subscribers are bundled into the queue workers' CLI registry
 * (modules.cli.generated.ts, esbuild, packages external). Two import shapes
 * break every worker, and `mercato server start` with them:
 *  - `@/...` resolves to the app root, not src, so the bundle cannot build;
 *  - `next/...` stays external and Node's ESM loader cannot resolve it
 *    ("Cannot find module .../next/server").
 * The automation dispatch made the rule executor worker-reachable (2026-09-28);
 * this walks every app subscriber's relative imports and forbids both.
 */
const SRC = join(__dirname, '../../../../')
const MODULES = join(SRC, 'modules')
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

function subscriberFiles(): string[] {
  const out: string[] = []
  for (const mod of readdirSync(MODULES)) {
    const dir = join(MODULES, mod, 'subscribers')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(join(dir, name))
    }
  }
  return out
}

function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec)
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

describe('worker-reachable code', () => {
  it('finds the app subscribers', () => {
    expect(subscriberFiles().length).toBeGreaterThan(5)
  })

  it('never imports @/ aliases or next/* from a subscriber or anything it reaches', () => {
    const offenders: string[] = []
    const seen = new Set<string>()
    const stack = subscriberFiles()
    while (stack.length) {
      const file = stack.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3]
        if (!spec) continue
        if (spec.startsWith('@/') || spec === 'next' || spec.startsWith('next/')) {
          offenders.push(`${relative(SRC, file)} -> ${spec}`)
        } else if (spec.startsWith('.')) {
          const target = resolveRelative(file, spec)
          if (target) stack.push(target)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
