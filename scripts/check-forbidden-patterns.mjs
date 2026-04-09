#!/usr/bin/env node
// Pre-commit drift guard. See AGENTS.md → "Forbidden Patterns" for the rationale.
//
// Blocks three categories of regression:
//   1. Net additions to setup-tables.sql (the deprecated raw-SQL schema file).
//   2. New files under apps/mercato/src/app/api/** that import knex directly.
//   3. New backend page files under apps/mercato/src/app/(backend)/backend/<feature>/.
//
// To bypass for a one-off legitimate change, set FORBIDDEN_PATTERNS_OVERRIDE=1
// in the environment AND document why in the commit message. Do not use --no-verify.

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname)
const OVERRIDE = process.env.FORBIDDEN_PATTERNS_OVERRIDE === '1'

function staged(filter) {
  const out = execSync(`git diff --cached --name-only --diff-filter=${filter}`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  return out.split('\n').filter(Boolean)
}

function stagedDiff(file) {
  try {
    return execSync(`git diff --cached -- "${file}"`, { cwd: REPO_ROOT, encoding: 'utf8' })
  } catch {
    return ''
  }
}

function fileContents(file) {
  const path = resolve(REPO_ROOT, file)
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8')
}

const violations = []

// Rule 1 — setup-tables.sql additions
const modifiedAndAdded = [...staged('AM'), ...staged('A')]
if (modifiedAndAdded.includes('setup-tables.sql')) {
  const diff = stagedDiff('setup-tables.sql')
  const addedLines = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  const meaningfulAdditions = addedLines.filter((line) => {
    const stripped = line.slice(1).trim()
    return stripped && !stripped.startsWith('--')
  })
  if (meaningfulAdditions.length > 0) {
    violations.push({
      rule: 'setup-tables.sql additions',
      file: 'setup-tables.sql',
      detail: `${meaningfulAdditions.length} new non-comment line(s) being added. setup-tables.sql is deprecated — new tables/columns must come from a mercato module entity.`,
      hint: 'Create or extend a module under packages/core/src/modules or apps/mercato/src/modules with data/entities.ts, then run `yarn db:generate`.',
    })
  }
}

// Rule 2 — new raw-knex API routes
const newFiles = staged('A')
const apiRoutePattern = /^apps\/mercato\/src\/app\/api\/.+\.(ts|tsx)$/
const importsKnex = (text) => {
  if (/from ['"]knex['"]/.test(text)) return true
  if (/getKnex\s*\(/.test(text)) return true
  if (/['"]knex['"]/.test(text) && /require\s*\(/.test(text)) return true
  return false
}
for (const file of newFiles) {
  if (!apiRoutePattern.test(file)) continue
  const text = fileContents(file)
  if (importsKnex(text)) {
    violations.push({
      rule: 'new raw-knex API route',
      file,
      detail: 'New file under apps/mercato/src/app/api/** imports knex directly. Raw-knex routes bypass tenant isolation, RBAC, audit logging, and the query index.',
      hint: 'Build this endpoint inside a mercato module with `makeCrudRoute` (see packages/core/src/modules/customers/api/people/route.ts as a reference).',
    })
  }
}

// Rule 3 — new standalone backend pages
const backendPagePattern = /^apps\/mercato\/src\/app\/\(backend\)\/backend\/[^/]+\/.*page\.tsx$/
for (const file of newFiles) {
  if (backendPagePattern.test(file)) {
    violations.push({
      rule: 'standalone backend page',
      file,
      detail: 'New backend page added directly under apps/mercato/src/app/(backend)/backend/. Backend pages must live in a module so the loader can apply the sidebar shell + RBAC guards.',
      hint: 'Move this page to <module>/backend/<path>.tsx — the catch-all router will pick it up automatically.',
    })
  }
}

if (violations.length === 0) {
  process.exit(0)
}

if (OVERRIDE) {
  console.error('⚠️  FORBIDDEN_PATTERNS_OVERRIDE=1 set — bypassing drift guards. Document the reason in the commit message:')
  for (const v of violations) {
    console.error(`   • ${v.rule}: ${v.file}`)
  }
  process.exit(0)
}

console.error('')
console.error('🛑 Pre-commit drift guard rejected this commit. See AGENTS.md → "Forbidden Patterns".')
console.error('')
for (const v of violations) {
  console.error(`   ❌ ${v.rule}`)
  console.error(`      file: ${v.file}`)
  console.error(`      ${v.detail}`)
  console.error(`      → ${v.hint}`)
  console.error('')
}
console.error('To override for a one-off legitimate case, set FORBIDDEN_PATTERNS_OVERRIDE=1 and explain in the commit message. Do NOT use --no-verify.')
console.error('')
process.exit(1)
