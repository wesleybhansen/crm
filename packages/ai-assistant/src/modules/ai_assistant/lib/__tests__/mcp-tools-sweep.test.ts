/**
 * MCP sweep 2026-09-25: optional tool arguments stayed optional, downstream
 * API failures are flagged isError, and find_api reads real endpoint docs.
 */
import { z } from 'zod'

const mockModules: unknown[] = []
jest.mock('@open-mercato/shared/lib/modules/registry', () => ({
  getModules: () => mockModules,
}))

import { jsonSchemaToZod, toolInputJsonSchema } from '../schema-utils'
import { isToolFailurePayload, mcpContentForResult } from '../tool-result'
import { clearEndpointCache, getApiEndpoints, searchEndpointsFallback } from '../api-endpoint-index'

describe('tool input schemas keep optional arguments optional', () => {
  const schema = z.object({
    contactId: z.string().describe('Contact id'),
    eventLimit: z.number().int().min(1).max(50).optional().default(10),
    limit: z.number().optional().default(10).describe('Max results'),
  })

  it('does not mark defaulted fields required', () => {
    const json = toolInputJsonSchema(schema)
    expect(json.required).toEqual(['contactId'])
  })

  it('round-trips to a Zod schema that accepts the call without them, keeping descriptions', () => {
    const converted = jsonSchemaToZod(toolInputJsonSchema(schema)) as z.ZodObject<z.ZodRawShape>
    expect(converted.safeParse({ contactId: 'c1' }).success).toBe(true)
    expect(converted.safeParse({ contactId: 'c1', eventLimit: 1.5 }).success).toBe(false)
    const roundTrip = z.toJSONSchema(converted) as { properties: Record<string, { description?: string }> }
    expect(roundTrip.properties.contactId.description).toBe('Contact id')
    expect(roundTrip.properties.limit.description).toBe('Max results')
  })
})

describe('tool results that report failure are MCP errors', () => {
  it('flags call_api style downstream failures with their status', () => {
    const payload = { success: false, statusCode: 422, error: 'API error 422: displayName is required', details: { error: 'displayName is required' } }
    expect(isToolFailurePayload(payload)).toBe(true)
    const content = mcpContentForResult(payload)
    expect(content.isError).toBe(true)
    expect(JSON.parse(content.content[0].text)).toMatchObject({ statusCode: 422 })
  })

  it('leaves ordinary results alone', () => {
    expect(mcpContentForResult({ success: true, data: [] }).isError).toBeUndefined()
    expect(mcpContentForResult([{ success: false }]).isError).toBeUndefined()
    expect(mcpContentForResult('ok').isError).toBeUndefined()
  })
})

describe('find_api reads real endpoint docs', () => {
  beforeEach(() => {
    clearEndpointCache()
    mockModules.length = 0
    mockModules.push({
      id: 'customers',
      apis: [
        {
          path: '/customers/people',
          handlers: { GET: async () => new Response(), POST: async () => new Response() },
          docs: {
            tag: 'Customers',
            methods: {
              GET: { summary: 'List people' },
              POST: {
                summary: 'Create person',
                description: 'Creates a person contact.',
                requestBody: { schema: z.object({ displayName: z.string(), primaryEmail: z.string().optional() }) },
              },
            },
          },
        },
        {
          path: '/customers/companies',
          handlers: { POST: async () => new Response() },
          docs: { methods: { POST: { summary: 'Create company' } } },
        },
      ],
    })
  })

  it('uses the registry: real summaries and the request body schema', async () => {
    const endpoints = await getApiEndpoints()
    const create = endpoints.find((e) => e.method === 'POST' && e.path.endsWith('/customers/people'))
    expect(create?.summary).toBe('Create person')
    expect(create?.description).not.toMatch(/operation for/)
    expect(Object.keys((create?.requestBodySchema as { properties: Record<string, unknown> }).properties)).toEqual(
      expect.arrayContaining(['displayName', 'primaryEmail']),
    )
  })

  it('finds the people endpoint for "create person"', async () => {
    await getApiEndpoints()
    const [first] = searchEndpointsFallback('create person', { limit: 3 })
    expect(first).toMatchObject({ method: 'POST' })
    expect(first.path).toMatch(/\/customers\/people$/)
  })
})
