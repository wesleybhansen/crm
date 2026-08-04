import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildPostgresDatabaseUrl,
  encodeRfc3986Component,
  launchDatabaseUrlEntrypoint,
  parseEntrypointCommand,
} from '../docker/scripts/database-url-entrypoint.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helperPath = resolve(repositoryRoot, 'docker/scripts/database-url-entrypoint.mjs')

function environment(overrides = {}) {
  return {
    POSTGRES_USER: 'crm',
    POSTGRES_PASSWORD: 'synthetic-password',
    POSTGRES_DB: 'crm',
    SYNTHETIC_SENTINEL: 'preserved',
    ...overrides,
  }
}

class FakeChild extends EventEmitter {
  signals = []

  kill(signal) {
    this.signals.push(signal)
    return true
  }
}

class FakeProcess extends EventEmitter {
  exitCode = undefined
  pid = 4242
  signals = []

  kill(pid, signal) {
    this.signals.push([pid, signal])
    return true
  }
}

test('strictly encodes ASCII, delimiters, percent, Unicode, and combining input', () => {
  assert.equal(encodeRfc3986Component('plain-._~09AZaz'), 'plain-._~09AZaz')
  assert.equal(
    encodeRfc3986Component(":/?#[]@!$&'()*+,;=%"),
    '%3A%2F%3F%23%5B%5D%40%21%24%26%27%28%29%2A%2B%2C%3B%3D%25',
  )
  assert.equal(encodeRfc3986Component('café'), 'caf%C3%A9')
  assert.equal(encodeRfc3986Component('😀'), '%F0%9F%98%80')
  assert.equal(encodeRfc3986Component('e\u0301'), 'e%CC%81')
})

test('constructs one exact round-tripping PostgreSQL URL', () => {
  const source = environment({
    POSTGRES_USER: "user!name",
    POSTGRES_PASSWORD: "p@ss:/?#[]!$&'()*+,;=%😀",
    POSTGRES_DB: 'db/name',
  })
  const databaseUrl = buildPostgresDatabaseUrl(source)
  const parsed = new URL(databaseUrl)

  assert.equal(parsed.protocol, 'postgres:')
  assert.equal(parsed.hostname, 'postgres')
  assert.equal(parsed.port, '5432')
  assert.equal(decodeURIComponent(parsed.username), source.POSTGRES_USER)
  assert.equal(decodeURIComponent(parsed.password), source.POSTGRES_PASSWORD)
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), source.POSTGRES_DB)
  assert.equal(parsed.search, '')
  assert.equal(parsed.hash, '')
})

test('fails closed on missing, empty, oversized, null, and malformed scalar input', () => {
  for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) {
    const missing = environment()
    delete missing[key]
    assert.throws(() => buildPostgresDatabaseUrl(missing), TypeError)
    assert.throws(() => buildPostgresDatabaseUrl(environment({ [key]: '' })), TypeError)
    assert.throws(() => buildPostgresDatabaseUrl(environment({ [key]: 'x'.repeat(65_536) })), TypeError)
    assert.throws(() => buildPostgresDatabaseUrl(environment({ [key]: 'x\0y' })), TypeError)
    assert.throws(() => buildPostgresDatabaseUrl(environment({ [key]: '\uD800' })))
  }
})

test('accepts only an exact separator and bounded command arguments', () => {
  assert.deepEqual(parseEntrypointCommand(['--', 'node', 'app.mjs', '--flag']), {
    command: 'node',
    commandArguments: ['app.mjs', '--flag'],
  })
  assert.throws(() => parseEntrypointCommand(['node', 'app.mjs']), TypeError)
  assert.throws(() => parseEntrypointCommand(['--']), TypeError)
  assert.throws(() => parseEntrypointCommand(['--', '']), TypeError)
  assert.throws(() => parseEntrypointCommand(['--', 'node', 'x\0y']), TypeError)
  assert.throws(() => parseEntrypointCommand(['--', 'node', ...Array(129).fill('x')]), TypeError)
})

test('changes only the child database URL and uses no shell', () => {
  const sourceEnvironment = environment({ DATABASE_URL: 'synthetic-old-value' })
  const child = new FakeChild()
  const processReference = new FakeProcess()
  let spawnProjection

  launchDatabaseUrlEntrypoint({
    argumentsList: ['--', 'node', 'app.mjs'],
    sourceEnvironment,
    processReference,
    spawnImplementation(command, commandArguments, options) {
      spawnProjection = { command, commandArguments, options }
      return child
    },
  })

  assert.equal(spawnProjection.command, 'node')
  assert.deepEqual(spawnProjection.commandArguments, ['app.mjs'])
  assert.equal(spawnProjection.options.shell, false)
  assert.equal(spawnProjection.options.stdio, 'inherit')
  assert.equal(spawnProjection.options.env.DATABASE_URL, buildPostgresDatabaseUrl(sourceEnvironment))
  assert.equal(spawnProjection.options.env.SYNTHETIC_SENTINEL, 'preserved')
  assert.equal(sourceEnvironment.DATABASE_URL, 'synthetic-old-value')

  child.emit('exit', 23, null)
  assert.equal(processReference.exitCode, 23)
})

test('forwards only the bounded signal allowlist and preserves signaled exit', () => {
  const child = new FakeChild()
  const processReference = new FakeProcess()

  launchDatabaseUrlEntrypoint({
    argumentsList: ['--', 'node'],
    sourceEnvironment: environment(),
    processReference,
    spawnImplementation: () => child,
  })

  processReference.emit('SIGTERM')
  processReference.emit('SIGINT')
  processReference.emit('SIGHUP')
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGINT', 'SIGHUP'])

  child.emit('exit', null, 'SIGTERM')
  assert.deepEqual(processReference.signals, [[4242, 'SIGTERM']])
  assert.equal(processReference.listenerCount('SIGTERM'), 0)
  assert.equal(processReference.listenerCount('SIGINT'), 0)
  assert.equal(processReference.listenerCount('SIGHUP'), 0)
})

test('runs without output and preserves the real child exit status', () => {
  const expectedDatabaseUrl = buildPostgresDatabaseUrl(environment({
    POSTGRES_USER: 'synthetic!user',
    POSTGRES_PASSWORD: 'synthetic:p@ss/word%😀',
    POSTGRES_DB: 'synthetic/db',
  }))
  const probeSource = [
    "if (process.env.DATABASE_URL !== process.env.EXPECTED_DATABASE_URL) process.exit(67)",
    "if (process.env.SYNTHETIC_SENTINEL !== 'preserved') process.exit(68)",
    'process.exit(23)',
  ].join(';')
  const result = spawnSync(
    process.execPath,
    [helperPath, '--', process.execPath, '-e', probeSource],
    {
      encoding: 'utf8',
      env: {
        POSTGRES_USER: 'synthetic!user',
        POSTGRES_PASSWORD: 'synthetic:p@ss/word%😀',
        POSTGRES_DB: 'synthetic/db',
        EXPECTED_DATABASE_URL: expectedDatabaseUrl,
        SYNTHETIC_SENTINEL: 'preserved',
      },
    },
  )

  assert.equal(result.status, 23)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('refuses invalid runtime input without output', () => {
  const result = spawnSync(process.execPath, [helperPath, '--', process.execPath, '-e', ''], {
    encoding: 'utf8',
    env: {
      POSTGRES_USER: 'synthetic-user',
      POSTGRES_DB: 'synthetic-db',
    },
  })

  assert.equal(result.status, 78)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('locks the production Compose and image boundary', () => {
  const composeSource = readFileSync(resolve(repositoryRoot, 'docker-compose.prod.yml'), 'utf8')
  const dockerfileSource = readFileSync(resolve(repositoryRoot, 'Dockerfile'), 'utf8')
  const helperSource = readFileSync(helperPath, 'utf8')
  const rawDatabaseUrlPattern = /DATABASE_URL:\s*postgres:\/\//g
  const helperReference = '/app/docker/scripts/database-url-entrypoint.mjs'
  const appCommand = `["node", "${helperReference}", "--", "sh", "-c", "cp .mercato/next/standalone/apps/mercato/server.js .mercato/next/standalone/apps/mercato/server.cjs && node .mercato/next/standalone/apps/mercato/server.cjs"]`
  const mcpCommand = `["node", "${helperReference}", "--", "node", "/app/packages/cli/bin/mercato", "ai_assistant", "mcp:serve-http", "--port", "3001"]`

  assert.equal(composeSource.match(rawDatabaseUrlPattern), null)
  assert.equal(composeSource.split(appCommand).length - 1, 1)
  assert.equal(composeSource.split(mcpCommand).length - 1, 1)
  assert.equal(
    dockerfileSource.split('COPY docker/scripts/database-url-entrypoint.mjs /app/docker/scripts/database-url-entrypoint.mjs').length - 1,
    1,
  )
  assert.doesNotMatch(helperSource, /console\.|process\.(?:stdout|stderr)|shell:\s*true/)
  assert.match(helperSource, /shell:\s*false/)
  assert.match(helperSource, /stdio:\s*'inherit'/)
})
