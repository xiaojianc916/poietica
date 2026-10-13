/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { defineUiFeature } from '@poietica/ui-kernel'
import { createConversationActions } from './setup/actions'
import { createConversationCommands } from './setup/commands'
import { createConversationSetup } from './setup/context'
import { createConversationContributions } from './setup/contributions'
import { createConversationServices } from './setup/services'
import { createConversationSubscriptions } from './setup/subscriptions'

/*
 * conversation 的装配层：这里只按顺序调五段，段落本体在 ui/setup/ 下。
 *
 * 原先整个文件是一段约 880 行的 setup()，端口、订阅、贡献、命令、服务全挤在同一个
 * 作用域里靠闭包互相看得见。拆开之后每一段收一份 setup 对象（store 与内核服务）与
 * 一份 actions（跨段共用的动作），装配次序仍在本文件里一眼可见。
 */
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
