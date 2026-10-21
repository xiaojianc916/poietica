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
  ctx.rpc.handle('threads.rename', async ({ threadId, title }) =>
    threads.threadOf(await threads.rename(threadId, title)),
  )
  ctx.rpc.handle('threads.setPinned', ({ threadId, pinned }) => threads.threadOf(threads.setPinned(threadId, pinned)))
  ctx.rpc.handle('threads.setArchived', ({ threadId, archived }) =>
    threads.threadOf(threads.setArchived(threadId, archived)),
  )
  ctx.rpc.handle('threads.delete', async ({ threadId }) => {
    await threads.delete(threadId)
    return {}
  })
  ctx.rpc.handle('threads.fork', async ({ threadId, keepTurns, title }) =>
    threads.threadOf(await threads.fork(threadId, keepTurns, title)),
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
    threads.requireRow(threadId)
    /*
     * 先取位置、再取整页：两步之间到达的增量会被 UI 缓存（05 页 §12.2）。
     * **不打开会话**（读写分离，性能方案 P1）：池里没有这条会话时整页来自会话文件的冷读（turns.page），真要写时才打开；
     * 打开时只给这一代里发过增量的通道换 epoch（ThreadService.onOpened → TimelineHub.resetAdvanced），所以这一份快照
     * 不会被随后的打开作废（R-03 §2.4 当初「先 acquire 再取位置」要防的正是那一次 reset）。
     */
    const pos = hub.position(threadId, agentId)
    /*
     * 提交号与提交行只属于主对话：子代理通道的 turnId 也从 t1 数起，按号盖章会把人的提交号盖到子代理的轮上，
     * 提交行也会在子代理的屏幕上再冒一遍。
     */
    if (agentId !== MAIN_AGENT_ID) {
      const page = await turns.page(threadId, agentId, null)
      return wireSnapshot(page, pos.epoch, pos.seq, [])
    }
    const page = submissions.stampPage(threadId, await turns.page(threadId, agentId, null))
    return wireSnapshot(page, pos.epoch, pos.seq, turns.submissionsOf(threadId, turnIdsOf(page)))
  })
  ctx.rpc.handle('timeline.unsubscribe', () => ({}))
  ctx.rpc.handle('timeline.page', async ({ threadId, agentId, beforeTurnId }) => {
    const page = await turns.page(threadId, agentId, beforeTurnId)
    return wirePage(agentId === MAIN_AGENT_ID ? submissions.stampPage(threadId, page) : page)
  })
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

  ctx.rpc.handle('subagents.cancel', async ({ threadId, agentId }) => ({
    cancelled: await turns.cancelSubagent(threadId, agentId),
  }))
  ctx.rpc.handle('subagents.steer', async ({ threadId, agentId, text }) => {
    await turns.steerSubagent(threadId, agentId, text)
    return {}
  })
  ctx.rpc.handle('backgroundTasks.cancel', async ({ threadId, taskId }) => ({
    cancelled: await turns.cancelBackgroundTask(threadId, taskId),
  }))

  ctx.rpc.handle('side.ask', async ({ threadId, question, topicId }) => ({
    topic: await turns.askSide(threadId, question, topicId),
  }))
  ctx.rpc.handle('side.cancel', ({ threadId, topicId }) => ({ cancelled: turns.cancelSide(threadId, topicId) }))
  ctx.rpc.handle('side.list', async ({ threadId }) => ({ topics: [...(await turns.sideTopics(threadId))] }))

  ctx.rpc.handle('controls.draft', (p) => turns.draftControls(p))
  ctx.rpc.handle('controls.setDraft', async (p) => {
    await turns.setDraftDefault({
      model: p.model,
      ...(p.thinking === undefined ? {} : { thinking: p.thinking }),
      ...(p.hidden === undefined ? {} : { hidden: p.hidden }),
    })
    return {}
  })
  ctx.rpc.handle('controls.get', ({ threadId }) => turns.controls(threadId))
  ctx.rpc.handle('controls.setModel', ({ threadId, model }) => turns.setModel(threadId, model))
  ctx.rpc.handle('controls.setThinking', ({ threadId, level }) => turns.setThinking(threadId, level))
  ctx.rpc.handle('controls.setPosture', ({ threadId, posture }) => turns.setPostureAction(threadId, posture))
  ctx.rpc.handle('controls.setPlanMode', ({ threadId, enabled }) => turns.setPlanMode(threadId, enabled))
  ctx.rpc.handle('controls.setGoal', ({ threadId, goal }) => turns.setGoal(threadId, goal))
  ctx.rpc.handle('controls.pauseGoal', ({ threadId }) => turns.pauseGoal(threadId))
  ctx.rpc.handle('controls.resumeGoal', ({ threadId }) => turns.resumeGoal(threadId))

  ctx.rpc.handle('commands.list', async ({ threadId }) => ({ commands: [...(await turns.commands(threadId))] }))
  ctx.rpc.handle('commands.catalog', async ({ workspaceId }) => ({
    commands: [...(await turns.commandCatalog(workspaceId))],
  }))
  ctx.rpc.handle('commands.run', async ({ threadId, text }) => {
    await turns.runCommand(threadId, text)
    return {}
  })

  ctx.rpc.handle('interactions.list', ({ threadId }) => ({ interactions: [...turns.interactions(threadId)] }))
  ctx.rpc.handle('interactions.respond', async ({ threadId, interactionId, answer }) => {
    await turns.respond(threadId, interactionId, answer)
    return {}
  })

  void AppError
}
