// Side-effect import: registers all tier 1 email commands in the global command registry.
// Without this, makeCrudRoute actions that reference commandId: 'email.lists.*' etc.
// fail at runtime with "Command handler not registered for id ...".
import './commands'

import type { AppContainer } from '@open-mercato/shared/lib/di/container'

export function register(_container: AppContainer) {
  // No DI registrations yet — the side-effect import above is the payload.
}
