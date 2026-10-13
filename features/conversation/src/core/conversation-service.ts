import { createId } from '@poietica/foundation'
import type { ConversationService } from '../core-api'
import type { ConversationCore } from './conversation'

/** core-api 的 ConversationService 只是组合 thread-service 与 turn-service，不写新逻辑 */
export function conversationService(core: ConversationCore): ConversationService {
  return {
    createThread(init) {
      const row = core.threads.create({
        workspaceId: init.workspaceId,
        title: init.title,
        origin: init.origin,
        posture: init.posture,
        model: init.model ?? undefined,
        thinking: init.thinking ?? undefined,
      })
      return core.threads.threadOf(row)
    },
    async submit(input) {
      /*
       * 提交号在这里现铸：Core 内部的调用方（automations 等）不关心这个号，以前交空串，
       * 而契约的 `clientTurnId` 是 `min(1)` —— strict 校验当场拒掉，提交与自动起标题跟着
       * 全失败（真实故障：定时任务线程的标题与提交都被判不合契约）。
       */
      await core.turns.submit({
        threadId: input.threadId,
        clientTurnId: createId(),
        text: input.text,
        attachmentIds: [],
        skills: [],
        deliverAs: 'turn',
      })
    },
    async cancel(threadId) {
      await core.turns.cancel(threadId)
    },
    get(threadId) {
      const row = core.threads.row(threadId)
      return row === null ? null : core.threads.threadOf(row)
    },
  }
}
