import type { CaptureResult } from 'posthog-js'

type ReplayRequest = {
  name?: string
}

type JsonRecord = Record<string, unknown>

const URL_PROPERTY_PATTERN = /(?:url|href)/i

function stripUrlSuffix(value: string): string {
  return value.split(/[?#]/, 1)[0]
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redactNestedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNestedValue)
  if (isRecord(value)) return redactRecord(value)
  return value
}

function redactRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      URL_PROPERTY_PATTERN.test(key) && typeof value === 'string'
        ? stripUrlSuffix(value)
        : redactNestedValue(value),
    ]),
  )
}

export function redactReplayRequestUrl<T extends ReplayRequest>(request: T): T {
  if (request.name) request.name = stripUrlSuffix(request.name)
  return request
}

export function redactPostHogEventUrls(
  event: CaptureResult | null,
): CaptureResult | null {
  if (!event) return null
  return {
    ...event,
    properties: redactRecord(event.properties),
    ...(event.$set ? { $set: redactRecord(event.$set) } : {}),
    ...(event.$set_once
      ? { $set_once: redactRecord(event.$set_once) }
      : {}),
  }
}
