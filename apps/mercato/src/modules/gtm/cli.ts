import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import './commands/social'

type CommandBusLike = {
  execute<TInput, TResult>(
    id: string,
    payload: { input: TInput; ctx: Record<string, unknown> },
  ): Promise<{ result: TResult }>
}

/*
 * Cron entry point for Threads OAuth token maintenance. The command itself
 * needs no user or organization scope (it walks every active connection and
 * refreshes tokens under each tenant's own key), so the CLI runs it with an
 * empty auth context. Usage: `mercato gtm social:refresh-threads-tokens`.
 */
const refreshThreadsTokens: ModuleCli = {
  command: 'social:refresh-threads-tokens',
  async run() {
    const container = await createRequestContainer()
    const commandBus = container.resolve('commandBus') as CommandBusLike
    const executed = await commandBus.execute<Record<string, never>, Record<string, number>>(
      'gtm.social.refresh-threads-tokens',
      {
        input: {},
        ctx: {
          container,
          auth: null,
          organizationScope: null,
          selectedOrganizationId: null,
          organizationIds: null,
        },
      },
    )
    console.log(JSON.stringify({ command: 'gtm.social.refresh-threads-tokens', ...executed.result }))
  },
}

const commands: ModuleCli[] = [refreshThreadsTokens]

export default commands
