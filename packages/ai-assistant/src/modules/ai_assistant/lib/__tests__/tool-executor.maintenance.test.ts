/* 2026-09-25 review, M6: MCP clients, the in-app assistant and the tools
 * endpoint execute tools here, past the HTTP dispatcher's maintenance guard. */
import { executeTool } from '../tool-executor'

jest.mock('../tool-registry', () => ({
  getToolRegistry: () => ({
    getTool: () => ({
      name: 'demo_write',
      inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
      handler: async () => ({ wrote: true }),
    }),
  }),
}))

describe('executeTool during maintenance', () => {
  const saved = process.env.MAINTENANCE
  afterEach(() => {
    if (saved === undefined) delete process.env.MAINTENANCE
    else process.env.MAINTENANCE = saved
  })

  it('refuses every tool while MAINTENANCE is set', async () => {
    process.env.MAINTENANCE = '1'
    const result = await executeTool('demo_write', {}, { container: { resolve: () => null } } as never)
    expect(result).toMatchObject({ success: false, errorCode: 'MAINTENANCE' })
  })
})
