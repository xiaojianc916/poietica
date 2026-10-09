import type { CoreModuleContext } from '@poietica/core-kernel'
import { AppError } from '@poietica/foundation'
import type { conversationContract } from '../contract'
import { MAIN_AGENT_ID } from '../contract/entities'
import type { ConversationCore } from './conversation'
import type { TimelineHub } from './timeline-hub'

type Ctx = CoreModuleContext<typeof conversationContract>

import { wireCatchUp, wirePage, wireSnapshot } from './wire'

/** 一页里出现过的 turn 号：提交行的 `started` 判据（在这一页里就不用再画提交行）。 */
function turnIdsOf(page: import('@poietica/transcript').TranscriptPage): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const item of page.items) {
    if (item.kind === 'turn') ids.add(item.turnId)
  }
  return ids
}

/** 契约方法 → 服务调用（每个 handler 一行） */
export function registerHandlers(ctx: Ctx, core: ConversationCore, hub: TimelineHub): void {
  ctx.rpc.handle('threads.list', (p) => ({ threads: core.list(p) }))
  ctx.rpc.handle('threads.get', ({ threadId }) => core.threadOf(core.requireRow(threadId)))
  ctx.rpc.handle('threads.create', (p) => core.threadOf(core.create(p)))
  ctx.rpc.handle('threads.open', async ({ threadId }) => {
    await core.open(threadId)
    return core.threadOf(core.requireRow(threadId))
  })
  ctx.rpc.handle('threads.close', async ({ threadId }) => {
    await core.close(threadId)
    return {}
  })
  ctx.rpc.handle('threads.rename', ({ threadId, title }) => core.threadOf(core.rename(threadId, title)))
  ctx.rpc.handle('threads.setPinned', ({ threadId, pinned }) => core.threadOf(core.setPinned(threadId, pinned)))
  ctx.rpc.handle('threads.setArchived', ({ threadId, archived }) => core.threadOf(core.setArchived(threadId, archived)))
  ctx.rpc.handle('threads.delete', async ({ threadId }) => {
    await core.delete(threadId)
    return {}
  })
  ctx.rpc.handle('threads.fork', async ({ threadId, undoTurns, title }) =>
    core.threadOf(await core.fork(threadId, undoTurns, title)),
  )
  ctx.rpc.handle('threads.export', ({ threadId, format, targetPath }) =>
    core.exportThread(threadId, format, targetPath),
  )

  ctx.rpc.handle('turns.submit', (p) =>
    core.submit({
      threadId: p.threadId,
      clientTurnId: p.clientTurnId,
      text: p.text,
      attachmentIds: p.attachmentIds,
      skills: p.skills,
      deliverAs: p.deliverAs,
    }),
  )
  ctx.rpc.handle('submissions.retry', ({ clientTurnId }) => ({ submission: core.retrySubmission(clientTurnId) }))
  ctx.rpc.handle('submissions.discard', ({ clientTurnId }) => {
    core.discardSubmission(clientTurnId)
    return {}
  })
  ctx.rpc.handle('turns.cancel', async ({ threadId }) => {
    await core.cancel(threadId)
    return {}
  })

  ctx.rpc.handle('timeline.subscribe', async ({ threadId, agentId }) => {
    const row = core.requireRow(threadId)
    if (row.sessionFile === null) {
      // 线程没有会话：返回空页，不打开会话（07 页 §5C 时间线通道）
      const pos = hub.position(threadId, agentId)
      const page = await core.emptyPage()
      return wireSnapshot(page, pos.epoch, pos.seq, core.submissionsOf(threadId, turnIdsOf(page)))
    }
    // 先取位置、再取整页：两步之间到达的增量会被 UI 缓存（05 页 §12.2）
    const pos = hub.position(threadId, agentId)
    const page = core.stampSubmissions(threadId, await core.page(threadId, agentId, null))
    return wireSnapshot(page, pos.epoch, pos.seq, core.submissionsOf(threadId, turnIdsOf(page)))
  })
  ctx.rpc.handle('timeline.unsubscribe', () => ({}))
  ctx.rpc.handle('timeline.page', async ({ threadId, agentId, beforeTurnId }) =>
    wirePage(core.stampSubmissions(threadId, await core.page(threadId, agentId, beforeTurnId))),
  )
  ctx.rpc.handle('timeline.catchUp', ({ threadId, agentId, epoch, sinceSeq }) => {
    return wireCatchUp(hub.catchUp(threadId, agentId, epoch, sinceSeq))
  })
  ctx.rpc.handle('queue.get', ({ threadId }) => core.queue(threadId))
  ctx.rpc.handle('queue.withdraw', ({ threadId, itemId }) => core.withdraw(threadId, itemId))
  ctx.rpc.handle('queue.move', ({ threadId, itemId, deliverAs }) => core.move(threadId, itemId, deliverAs))
  ctx.rpc.handle('queue.setModes', ({ threadId, steer, followUp }) =>
    core.setQueueModes(threadId, {
      ...(steer === undefined ? {} : { steer }),
      ...(followUp === undefined ? {} : { followUp }),
    }),
  )

  ctx.rpc.handle('controls.draft', (p) => core.draftControls(p))
  ctx.rpc.handle('controls.get', ({ threadId }) => core.controls(threadId))
  ctx.rpc.handle('controls.setModel', ({ threadId, model }) => core.setModel(threadId, model))
  ctx.rpc.handle('controls.setThinking', ({ threadId, level }) => core.setThinking(threadId, level))
  ctx.rpc.handle('controls.setPosture', ({ threadId, posture }) => core.setPostureAction(threadId, posture))
  ctx.rpc.handle('controls.setPlanMode', ({ threadId, enabled }) => core.setPlanMode(threadId, enabled))
  ctx.rpc.handle('controls.setGoal', ({ threadId, goal }) => core.setGoal(threadId, goal))

  ctx.rpc.handle('interactions.list', ({ threadId }) => ({ interactions: [...core.interactions(threadId)] }))
  ctx.rpc.handle('interactions.respond', async ({ threadId, interactionId, answer }) => {
    await core.respond(threadId, interactionId, answer)
    return {}
  })

  void MAIN_AGENT_ID
  void AppError
}
