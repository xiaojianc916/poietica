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
  /* 三份服务直接调（R-08-7 撤掉了门面上的纯转发）：这里只认它们各自的公开方法 */
  const { threads, turns, submissions } = core

  ctx.rpc.handle('threads.list', (p) => ({ threads: threads.list(p) }))
  ctx.rpc.handle('threads.get', ({ threadId }) => threads.threadOf(threads.requireRow(threadId)))
  ctx.rpc.handle('threads.create', (p) => threads.threadOf(threads.create(p)))
  ctx.rpc.handle('threads.open', async ({ threadId }) => {
    await turns.open(threadId)
    return threads.threadOf(threads.requireRow(threadId))
  })
  ctx.rpc.handle('threads.close', async ({ threadId }) => {
    await turns.close(threadId)
    return {}
  })
  ctx.rpc.handle('threads.rename', ({ threadId, title }) => threads.threadOf(threads.rename(threadId, title)))
  ctx.rpc.handle('threads.setPinned', ({ threadId, pinned }) => threads.threadOf(threads.setPinned(threadId, pinned)))
  ctx.rpc.handle('threads.setArchived', ({ threadId, archived }) =>
    threads.threadOf(threads.setArchived(threadId, archived)),
  )
  ctx.rpc.handle('threads.delete', async ({ threadId }) => {
    await threads.delete(threadId)
    return {}
  })
  ctx.rpc.handle('threads.fork', async ({ threadId, undoTurns, title }) =>
    threads.threadOf(await threads.fork(threadId, undoTurns, title)),
  )
  ctx.rpc.handle('threads.export', ({ threadId, format, targetPath }) =>
    threads.exportThread(threadId, format, targetPath),
  )

  ctx.rpc.handle('turns.submit', (p) =>
    turns.submit({
      threadId: p.threadId,
      clientTurnId: p.clientTurnId,
      text: p.text,
      attachmentIds: p.attachmentIds,
      skills: p.skills,
      deliverAs: p.deliverAs,
    }),
  )
  ctx.rpc.handle('submissions.retry', ({ clientTurnId }) => ({ submission: submissions.retry(clientTurnId) }))
  ctx.rpc.handle('submissions.discard', ({ clientTurnId }) => {
    submissions.discard(clientTurnId)
    return {}
  })
  ctx.rpc.handle('turns.cancel', async ({ threadId }) => {
    await turns.cancel(threadId)
    return {}
  })

  ctx.rpc.handle('timeline.subscribe', async ({ threadId, agentId }) => {
    const row = threads.requireRow(threadId)
    if (row.sessionFile === null) {
      // 线程没有会话：返回空页，不打开会话（07 页 §5C 时间线通道）
      const pos = hub.position(threadId, agentId)
      const page = turns.emptyPage()
      return wireSnapshot(page, pos.epoch, pos.seq, turns.submissionsOf(threadId, turnIdsOf(page)))
    }
    /*
     * 先把会话拿到手：冷打开会在 onOpened 里换 epoch，必须发生在取位置之前 ——
     * 否则这次订阅拿到的是旧 epoch，UI 还会收到一条 reset 再整读一次（R-03 §2.4）。
     * 再取位置、最后取整页：后两步之间到达的增量会被 UI 缓存（05 页 §12.2）。
     */
    await turns.acquire(threadId)
    const pos = hub.position(threadId, agentId)
    const page = submissions.stampPage(threadId, await turns.page(threadId, agentId, null))
    return wireSnapshot(page, pos.epoch, pos.seq, turns.submissionsOf(threadId, turnIdsOf(page)))
  })
  ctx.rpc.handle('timeline.unsubscribe', () => ({}))
  ctx.rpc.handle('timeline.page', async ({ threadId, agentId, beforeTurnId }) =>
    wirePage(submissions.stampPage(threadId, await turns.page(threadId, agentId, beforeTurnId))),
  )
  ctx.rpc.handle('timeline.catchUp', ({ threadId, agentId, epoch, sinceSeq }) => {
    return wireCatchUp(hub.catchUp(threadId, agentId, epoch, sinceSeq))
  })
  ctx.rpc.handle('queue.get', ({ threadId }) => turns.queue(threadId))
  ctx.rpc.handle('queue.withdraw', ({ threadId, itemId }) => turns.withdraw(threadId, itemId))
  ctx.rpc.handle('queue.move', ({ threadId, itemId, deliverAs }) => turns.move(threadId, itemId, deliverAs))
  ctx.rpc.handle('queue.setModes', ({ threadId, steer, followUp }) =>
    turns.setQueueModes(threadId, {
      ...(steer === undefined ? {} : { steer }),
      ...(followUp === undefined ? {} : { followUp }),
    }),
  )

  ctx.rpc.handle('controls.draft', (p) => turns.draftControls(p))
  ctx.rpc.handle('controls.get', ({ threadId }) => turns.controls(threadId))
  ctx.rpc.handle('controls.setModel', ({ threadId, model }) => turns.setModel(threadId, model))
  ctx.rpc.handle('controls.setThinking', ({ threadId, level }) => turns.setThinking(threadId, level))
  ctx.rpc.handle('controls.setPosture', ({ threadId, posture }) => turns.setPostureAction(threadId, posture))
  ctx.rpc.handle('controls.setPlanMode', ({ threadId, enabled }) => turns.setPlanMode(threadId, enabled))
  ctx.rpc.handle('controls.setGoal', ({ threadId, goal }) => turns.setGoal(threadId, goal))
  ctx.rpc.handle('controls.pauseGoal', ({ threadId }) => turns.pauseGoal(threadId))
  ctx.rpc.handle('controls.resumeGoal', ({ threadId }) => turns.resumeGoal(threadId))

  ctx.rpc.handle('interactions.list', ({ threadId }) => ({ interactions: [...turns.interactions(threadId)] }))
  ctx.rpc.handle('interactions.respond', async ({ threadId, interactionId, answer }) => {
    await turns.respond(threadId, interactionId, answer)
    return {}
  })

  void MAIN_AGENT_ID
  void AppError
}
