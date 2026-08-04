import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const CONFIGURATION_EXIT_CODE = 78
const SOFTWARE_EXIT_CODE = 70
const MAX_COMPONENT_LENGTH = 65_535
const MAX_COMMAND_ARGUMENTS = 128
const MAX_COMMAND_ARGUMENT_LENGTH = 131_072
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP']

function requireFiniteString(value, maximumLength, allowEmpty = false) {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > maximumLength
    || value.includes('\0')
  ) {
    throw new TypeError('invalid runtime input')
  }
  return value
}

export function encodeRfc3986Component(value) {
  const input = requireFiniteString(value, MAX_COMPONENT_LENGTH)
  return encodeURIComponent(input).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
}

export function buildPostgresDatabaseUrl(sourceEnvironment) {
  if (!sourceEnvironment || typeof sourceEnvironment !== 'object') {
    throw new TypeError('invalid runtime input')
  }

  const username = requireFiniteString(sourceEnvironment.POSTGRES_USER, MAX_COMPONENT_LENGTH)
  const password = requireFiniteString(sourceEnvironment.POSTGRES_PASSWORD, MAX_COMPONENT_LENGTH)
  const database = requireFiniteString(sourceEnvironment.POSTGRES_DB, MAX_COMPONENT_LENGTH)
  const encodedUsername = encodeRfc3986Component(username)
  const encodedPassword = encodeRfc3986Component(password)
  const encodedDatabase = encodeRfc3986Component(database)
  const databaseUrl = `postgres://${encodedUsername}:${encodedPassword}@postgres:5432/${encodedDatabase}`
  const parsed = new URL(databaseUrl)

  if (
    parsed.protocol !== 'postgres:'
    || parsed.hostname !== 'postgres'
    || parsed.port !== '5432'
    || parsed.search !== ''
    || parsed.hash !== ''
    || decodeURIComponent(parsed.username) !== username
    || decodeURIComponent(parsed.password) !== password
    || decodeURIComponent(parsed.pathname.slice(1)) !== database
  ) {
    throw new TypeError('invalid runtime input')
  }

  return databaseUrl
}

export function parseEntrypointCommand(argumentsList) {
  if (
    !Array.isArray(argumentsList)
    || argumentsList.length < 2
    || argumentsList.length > MAX_COMMAND_ARGUMENTS + 1
    || argumentsList[0] !== '--'
  ) {
    throw new TypeError('invalid runtime input')
  }

  const command = requireFiniteString(argumentsList[1], MAX_COMMAND_ARGUMENT_LENGTH)
  const commandArguments = argumentsList.slice(2).map((argument) => (
    requireFiniteString(argument, MAX_COMMAND_ARGUMENT_LENGTH, true)
  ))
  return { command, commandArguments }
}

export function launchDatabaseUrlEntrypoint({
  argumentsList = process.argv.slice(2),
  sourceEnvironment = process.env,
  spawnImplementation = spawn,
  processReference = process,
} = {}) {
  const databaseUrl = buildPostgresDatabaseUrl(sourceEnvironment)
  const { command, commandArguments } = parseEntrypointCommand(argumentsList)
  const childEnvironment = { ...sourceEnvironment, DATABASE_URL: databaseUrl }
  const child = spawnImplementation(command, commandArguments, {
    env: childEnvironment,
    shell: false,
    stdio: 'inherit',
  })
  let settled = false
  const signalHandlers = new Map()

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      processReference.off(signal, handler)
    }
    signalHandlers.clear()
  }

  const finishWithCode = (code) => {
    if (settled) return
    settled = true
    removeSignalHandlers()
    processReference.exitCode = Number.isInteger(code) && code >= 0 && code <= 255
      ? code
      : SOFTWARE_EXIT_CODE
  }

  const finishWithSignal = (signal) => {
    if (settled) return
    settled = true
    removeSignalHandlers()
    try {
      processReference.kill(processReference.pid, signal)
    } catch {
      processReference.exitCode = SOFTWARE_EXIT_CODE
    }
  }

  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      try {
        child.kill(signal)
      } catch {
        finishWithCode(SOFTWARE_EXIT_CODE)
      }
    }
    signalHandlers.set(signal, handler)
    processReference.on(signal, handler)
  }

  child.once('error', () => finishWithCode(SOFTWARE_EXIT_CODE))
  child.once('exit', (code, signal) => {
    if (signal) {
      finishWithSignal(signal)
      return
    }
    finishWithCode(code)
  })

  return child
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    launchDatabaseUrlEntrypoint()
  } catch {
    process.exitCode = CONFIGURATION_EXIT_CODE
  }
}
