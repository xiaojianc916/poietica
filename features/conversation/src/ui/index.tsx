/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { defineUiFeature } from '@poietica/ui-kernel'
import { createConversationActions } from './setup/actions'
import { createConversationCommands } from './setup/commands'
import { createConversationSetup } from './setup/context'
import { createConversationContributions } from './setup/contributions'
import { createConversationServices } from './setup/services'
import { createConversationSubscriptions } from './setup/subscriptions'

/* conversation 的装配层：只按顺序调五段，段落本体在 ui/setup/ 下 —— 别把段落正文搬回来。 */
export default defineUiFeature({
  id: 'conversation',
  dependsOn: ['workspaces', 'preferences', 'platform'],
  setup(ctx) {
    const setup = createConversationSetup(ctx)
    const actions = createConversationActions(setup)
    createConversationSubscriptions(setup, actions)
    createConversationContributions(setup, actions)
    createConversationCommands(setup, actions)
    createConversationServices(setup, actions)
  },
})
