import { defineCoreModule } from '@poietica/core-kernel'
import { type AttachmentsService, AttachmentsServiceToken } from '@poietica/feature-attachments/core-api'
import {
  type WorkspaceRemoved,
  type WorkspacesService,
  WorkspacesServiceToken,
  workspaceRemoved,
} from '@poietica/feature-workspaces/core-api'
import { conversationContract } from '../contract'
import {
  ConversationServiceToken,
  submissionFailed,
  threadRemoved,
  turnSettled,
  usageSampled,
  userMessageSubmitted,
} from '../core-api'
import { ConversationCore } from './conversation'
import { conversationService } from './conversation-service'
import { registerHandlers } from './handlers'
import { migrations } from './migrations'
import { TimelineHub } from './timeline-hub'
import { wireOpsNotice, wireResetNotice } from './wire'

export default defineCoreModule({
  id: 'conversation',
  contract: conversationContract,
  dependsOn: ['workspaces', 'attachments'],
  migrations,
  setup(ctx) {
    const hub = new TimelineHub({
      clock: ctx.clock,
      emitOps: (p) => ctx.rpc.emit('timeline.ops', wireOpsNotice(p)),
      emitReset: (p) => ctx.rpc.emit('timeline.reset', wireResetNotice(p)),
    })

    const core = new ConversationCore({
      db: ctx.db,
      engine: ctx.engine,
      hub,
      workspaces: ctx.services.get(WorkspacesServiceToken) as WorkspacesService,
      attachments: ctx.services.get(AttachmentsServiceToken) as AttachmentsService,
      clock: ctx.clock,
      logger: ctx.logger,
      emitThreadUpdated: (thread) => ctx.rpc.emit('threads.updated', thread),
      emitThreadRemoved: (threadId) => ctx.rpc.emit('threads.removed', { threadId }),
      emitTurnState: (state) => ctx.rpc.emit('turns.state', state),
      emitTurnDropped: (p) => ctx.rpc.emit('turns.dropped', p),
      emitQueue: (p) => ctx.rpc.emit('queue.changed', p),
      emitControls: (p) => ctx.rpc.emit('controls.changed', p),
      emitContextUsage: (p) => ctx.rpc.emit('controls.contextChanged', p),
      emitInteractionRequested: (p) => ctx.rpc.emit('interactions.requested', p),
      emitInteractionResolved: (p) => ctx.rpc.emit('interactions.resolved', p),
      emitSubmissionChanged: (submission) =>
        ctx.rpc.emit('submissions.changed', { threadId: submission.threadId, submission }),
      emitSubmissionRemoved: (p) => ctx.rpc.emit('submissions.removed', p),
      emitTurnSettled: (p) => ctx.events.emit(turnSettled, p),
      emitSubmissionFailed: (p) => ctx.events.emit(submissionFailed, p),
      emitThreadRemovedEvent: (p) => ctx.events.emit(threadRemoved, p),
      emitUsageSampled: (p) => ctx.events.emit(usageSampled, p),
      emitUserMessage: (p) => ctx.events.emit(userMessageSubmitted, p),
    })

    registerHandlers(ctx, core, hub)
    ctx.services.provide(ConversationServiceToken, conversationService(core))

    // 引擎配置变化：会话池换代 —— 空闲的立刻释放；变更时正在跑的会话这一轮结束后释放（R-03）
    const invalidateSessions = (): void => {
      void core.turns.invalidateSessions()
    }
    ctx.disposables.add(ctx.engine.settings.onDidChange(invalidateSessions))
    ctx.disposables.add(ctx.engine.models.onDidChange(invalidateSessions))

    /*
     * 模型列表变了 → 通知入口页重读**草稿**表（方案 §05 的 controls.draftChanged）。
     *
     * 草稿选择是入口页本地的，Core 不知道用户此刻在草稿里选了什么，所以这条通知不带参数：
     * 它只说「目录变了」，重读由入口页自己发起（带上它手里的草稿）。装/卸服务商、启停模型
     * 都会走到这里 —— 少了它，用户在设置里配好 key 回到首页，那排选择器还是旧的那一份
     * （空的），要切一次页面才刷新。
     */
    ctx.disposables.add(
      ctx.engine.models.onDidChange(() => {
        ctx.rpc.emit('controls.draftChanged', {})
      }),
    )

    // 工作区被移除：其中所有线程被删除（运行中的先取消）
    ctx.disposables.add(
      ctx.events.on<WorkspaceRemoved>(workspaceRemoved, (e) => {
        void core.threads.removeWorkspaceThreads(e.workspaceId).catch((err: unknown) => {
          ctx.logger.warn('workspace cascade failed', { workspaceId: e.workspaceId, error: String(err) })
        })
      }),
    )

    // 会话池与 hub 的释放都是异步/有序的：模块的 onShutdown 里逐个做（07 页 §5C）
    ctx.lifecycle.onShutdown(async () => {
      hub.dispose()
      await core.dispose()
    })
  },
})
