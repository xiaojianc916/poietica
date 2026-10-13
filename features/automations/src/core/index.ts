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
import { localTimeZone } from './time'

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
      emitAttention: (attention) => ctx.rpc.emit('automations.attention', attention),
      emitChanged: () => ctx.rpc.emit('automations.changed', {}),
    })
    const scheduler = createScheduler({ repo, runner, clock: ctx.clock, logger: ctx.logger })
    const service = createAutomationsService({ repo, runner, conversation, clock: ctx.clock, logger: ctx.logger })

    registerHandlers(ctx, service)
    registerAgentTools({
      tools: ctx.agentTools,
      service,
      conversation,
      workspaces,
      engine: ctx.engine,
      clock: ctx.clock,
      localTimeZone,
    })

    ctx.disposables.add(
      ctx.events.on<TurnSettled>(turnSettled, (e) => {
        runner.onTurnSettled(e)
      }),
    )

    ctx.disposables.add(
      ctx.events.on<SubmissionFailed>(submissionFailed, (e) => {
        runner.onSubmissionFailed(e)
      }),
    )
    ctx.disposables.add(
      ctx.events.on<ThreadRemoved>(threadRemoved, (e) => {
        runner.onThreadRemoved(e)
        if (repo.clearThread(e.threadId, ctx.clock.now()) > 0) ctx.rpc.emit('automations.changed', {})
      }),
    )

    ctx.disposables.add(
      ctx.events.on<WorkspaceRemoved>(workspaceRemoved, (e) => {
        repo.removeByWorkspace(e.workspaceId)
        ctx.rpc.emit('automations.changed', {})
      }),
    )

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
