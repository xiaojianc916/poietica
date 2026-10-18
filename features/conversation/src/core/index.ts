import { defineCoreModule } from '@poietica/core-kernel'
import { AttachmentsServiceToken } from '@poietica/feature-attachments/core-api'
import { type WorkspaceRemoved, WorkspacesServiceToken, workspaceRemoved } from '@poietica/feature-workspaces/core-api'
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
import { registerImageTool } from './image-tool'
import { migrations } from './migrations'
import { TimelineHub } from './timeline-hub'
import { registerWidgetTool } from './widget-tool'
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

    const attachments = ctx.services.get(AttachmentsServiceToken)
    const core = new ConversationCore({
      db: ctx.db,
      engine: ctx.engine,
      hub,
      workspaces: ctx.services.get(WorkspacesServiceToken),
      attachments,
      clock: ctx.clock,
      logger: ctx.logger,
      emitThreadUpdated: (thread) => ctx.rpc.emit('threads.updated', thread),
      emitThreadRemoved: (threadId) => ctx.rpc.emit('threads.removed', { threadId }),
      emitTurnState: (state) => ctx.rpc.emit('turns.state', state),
      emitTurnDropped: (p) => ctx.rpc.emit('turns.dropped', p),
      emitQueue: (p) => ctx.rpc.emit('queue.changed', p),
      emitControls: (p) => ctx.rpc.emit('controls.changed', p),
      emitContextUsage: (p) => ctx.rpc.emit('controls.contextChanged', p),
      emitCommandOutput: (p) => ctx.rpc.emit('commands.output', p),
      emitCommandsChanged: (p) => ctx.rpc.emit('commands.changed', p),
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
    // R-13：agent 往对话里展示图片的正式入口。工具集在全部 setup 之后冻结，只能在这里注册
    registerImageTool({ tools: ctx.agentTools, attachments })
    // R-18：同一条理由
    registerWidgetTool({ tools: ctx.agentTools })
    ctx.services.provide(ConversationServiceToken, conversationService(core))

    // 引擎配置变化：会话池换代 —— 空闲的立刻释放；变更时正在跑的会话这一轮结束后释放（R-03）
    const invalidateSessions = (): void => {
      void core.turns.invalidateSessions()
    }
    ctx.disposables.add(ctx.engine.settings.onDidChange(invalidateSessions))
    ctx.disposables.add(ctx.engine.models.onDidChange(invalidateSessions))

    /*
     * 模型列表变了 → 通知入口页重读**草稿**表。草稿选择是入口页本地的，Core 不知道用户选了
     * 什么，所以这条通知不带参数。少了它，用户在设置里配好 key 回到首页，那排选择器还是空的，
     * 要切一次页面才刷新。
     */
    const draftChanged = (): void => {
      ctx.rpc.emit('controls.draftChanged', {})
    }
    ctx.disposables.add(ctx.engine.models.onDidChange(draftChanged))
    /*
     * 只是「新对话默认模型 / 档位」变了（入口页写穿意图、模型页设为默认）：草稿表要重读，但**不**换代
     * 会话池 —— 活着的会话早定好了自己的模型与档位。旧版两者共用 onDidChange，入口页每切一次模型就把
     * 空闲会话全部释放，下一次进对话要重开会话。
     */
    ctx.disposables.add(ctx.engine.models.onDidChangeDefaults(draftChanged))

    // 工作区被移除：其中所有线程被删除（运行中的先取消）
    ctx.disposables.add(
      ctx.events.on<WorkspaceRemoved>(workspaceRemoved, (e) => {
        void core.threads.removeWorkspaceThreads(e.workspaceId).catch((err: unknown) => {
          ctx.logger.warn('workspace cascade failed', { workspaceId: e.workspaceId, error: String(err) })
        })
      }),
    )

    /*
     * 启动对账（会话池还没开过任何会话，UI 的请求要等 core.ready）：
     * 1. 行上绑着、文件却不在的 —— 解绑，回到「还没有会话」（升级前留下的坏账，见 reconcileSessionFiles）；
     * 2. 回收队列里上次没删掉的会话文件 —— 再删一遍，不阻塞启动；
     * 3. 删完之后回收会话媒体：没有任何会话文件再引用的图片（删掉的对话里的截图、粘贴图）。图片按内容寻址、
     *    可能被多条会话共用，所以删对话时不能顺手删，只能等全部会话文件都在场时标记一遍（omp gc 的 blobs 段，子进程里跑）。
     */
    const maintenance = new AbortController()
    ctx.lifecycle.onReady(async () => {
      await core.threads.reconcileSessionFiles()
      void core.threads
        .reclaimPending()
        .catch((err: unknown) => {
          ctx.logger.warn('session file reclaim failed', { error: String(err) })
        })
        .then(() => (maintenance.signal.aborted ? null : ctx.engine.sessionFiles.collectGarbage(maintenance.signal)))
        .then((gc) => {
          if (gc !== null && (gc.deletedFiles > 0 || gc.errors.length > 0)) {
            ctx.logger.info('session media collected', { ...gc })
          }
        })
        .catch((err: unknown) => {
          if (!maintenance.signal.aborted) ctx.logger.warn('session media gc failed', { error: String(err) })
        })
    })

    // 会话池与 hub 的释放都是异步/有序的：模块的 onShutdown 里逐个做
    ctx.lifecycle.onShutdown(async () => {
      maintenance.abort()
      hub.dispose()
      await core.dispose()
    })
  },
})
