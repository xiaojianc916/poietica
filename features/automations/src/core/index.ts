import { defineCoreModule } from '@poietica/core-kernel'
import {
  type ConversationService,
  ConversationServiceToken,
  type SubmissionFailed,
  submissionFailed,
  type ThreadRemoved,
  type TurnSettled,
  threadRemoved,
  turnSettled,
} from '@poietica/feature-conversation/core-api'
import {
  type WorkspaceRemoved,
  type WorkspacesService,
  WorkspacesServiceToken,
  workspaceRemoved,
} from '@poietica/feature-workspaces/core-api'
import { automationsContract } from '../contract'
import { registerAgentTools } from './agent-tools'
import { registerHandlers } from './handlers'
import { migrations } from './migrations'
import { createAutomationsRepository } from './repository'
import { createRunner } from './runner'
import { createScheduler } from './scheduler'
import { createAutomationsService } from './service'

export default defineCoreModule({
  id: 'automations',
  contract: automationsContract,
  dependsOn: ['conversation', 'workspaces'],
  migrations,
  setup(ctx) {
    const repo = createAutomationsRepository(ctx.db)
    const conversation = ctx.services.get(ConversationServiceToken) as ConversationService
    const workspaces = ctx.services.get(WorkspacesServiceToken) as WorkspacesService

    const runner = createRunner({
      repo,
      conversation,
      workspaces,
      clock: ctx.clock,
      logger: ctx.logger,
      emitRunUpdated: (run) => ctx.rpc.emit('automations.runUpdated', run),
    })
    const scheduler = createScheduler({ repo, runner, clock: ctx.clock, logger: ctx.logger })
    const service = createAutomationsService({ repo, runner, clock: ctx.clock, logger: ctx.logger })

    registerHandlers(ctx, service)
    registerAgentTools({ tools: ctx.agentTools, service, conversation, workspaces })

    /* 结束：conversation 的 turnSettled 按 threadId 落到本次运行 */
    ctx.disposables.add(
      ctx.events.on<TurnSettled>(turnSettled, (e) => {
        runner.onTurnSettled(e)
      }),
    )

    /*
     * R-06：「一句话没送达」与「对话被删」都不会有回合结束事件，靠这两条 Core 事件收口，
     * 否则 open run 永远收不掉，调度器会一直跳过这个任务。
     */
    ctx.disposables.add(
      ctx.events.on<SubmissionFailed>(submissionFailed, (e) => {
        runner.onSubmissionFailed(e)
      }),
    )
    ctx.disposables.add(
      ctx.events.on<ThreadRemoved>(threadRemoved, (e) => {
        runner.onThreadRemoved(e)
      }),
    )

    /* 工作区被移除：删掉它名下的全部任务（运行记录级联；线程归 conversation 删） */
    ctx.disposables.add(
      ctx.events.on<WorkspaceRemoved>(workspaceRemoved, (e) => {
        repo.removeByWorkspace(e.workspaceId)
        ctx.rpc.emit('automations.changed', {})
      }),
    )

    /* 启动修复在 onReady：上次退出时仍在运行的记录 → failed；重算 next_run_at 与 issue */
    ctx.lifecycle.onReady(() => {
      scheduler.repairOnStartup()
      ctx.disposables.add(scheduler.start())
      ctx.rpc.emit('automations.changed', {})
    })

    ctx.lifecycle.onShutdown(() => {
      runner.dispose()
    })
  },
})
