import type { Controls, ModelRef } from '@poietica/engine'
import { conversationContract, MAIN_AGENT_ID, type Thread } from '@poietica/feature-conversation/contract'
import { platformContract } from '@poietica/feature-platform/contract'
import type { Logger } from '@poietica/foundation'
import type { TypedRpcClient } from '@poietica/rpc'
import type { TranscriptPage } from '@poietica/transcript'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import type {
  Automation,
  AutomationAttention,
  AutomationDraft,
  AutomationRun,
  Schedule,
  ScheduleProblem,
} from '../contract'
import { automationsContract } from '../contract'

/* `ctx.rpc(automationsContract)` 的薄封装。新契约逐方法给出，界面不再认识 legacy 那种「目录快照」。 */

export interface AutomationsApi {
  list(): Promise<Automation[]>
  get(automationId: string): Promise<Automation>
  create(draft: AutomationDraft): Promise<Automation>
  update(automationId: string, patch: Partial<AutomationDraft>): Promise<Automation>
  remove(automationId: string): Promise<void>
  setEnabled(automationId: string, enabled: boolean): Promise<Automation>
  runNow(automationId: string): Promise<AutomationRun>
  cancelRun(runId: string): Promise<void>
  runs(automationId: string, limit: number): Promise<AutomationRun[]>
  previewSchedule(schedule: Schedule, count: number): Promise<{ times: number[]; problem: ScheduleProblem | null }>
  onChanged(listener: () => void): { dispose(): void }
  onRunUpdated(listener: (run: AutomationRun) => void): { dispose(): void }
  onAttention(listener: (attention: AutomationAttention) => void): { dispose(): void }
  draftControls(model: ModelRef | null): Promise<Controls>
}

export interface AutomationsUiApi extends AutomationsApi {
  notify(attention: AutomationAttention): Promise<void>
  firstUserPrompt(thread: Thread, logger: Logger): Promise<string | null>
}

function promptIn(items: readonly unknown[]): string | null {
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('kind' in item) || item.kind !== 'turn') continue
    const origin = 'origin' in item ? item.origin : null
    const kind = typeof origin === 'object' && origin !== null && 'kind' in origin ? origin.kind : undefined
    const prompt = 'prompt' in item ? item.prompt : null
    if ((kind === undefined || kind === 'user') && typeof prompt === 'string' && prompt.trim() !== '') return prompt
  }
  return null
}

async function firstUserPrompt(
  rpc: TypedRpcClient<typeof conversationContract>,
  thread: Thread,
  logger: Logger,
): Promise<string | null> {
  const args = { threadId: thread.id, agentId: MAIN_AGENT_ID }
  let subscribed = false
  try {
    let page = (await rpc.call('timeline.subscribe', args)).page
    subscribed = true
    for (let turn = 0; turn < 10; turn += 1) {
      const prompt = promptIn(page.items)
      if (prompt !== null || page.hasMoreOlder !== true) return prompt
      const beforeTurnId = page.items.find(
        (item): item is TranscriptPage['items'][number] & { kind: 'turn'; turnId: string } =>
          item.kind === 'turn' && typeof item.turnId === 'string',
      )?.turnId
      if (beforeTurnId === undefined) return null
      page = await rpc.call('timeline.page', { ...args, beforeTurnId })
    }
  } catch (cause: unknown) {
    logger.warn('定时任务预填：线程首条用户消息读取失败', { error: String(cause) })
  } finally {
    if (subscribed) {
      try {
        await rpc.call('timeline.unsubscribe', args)
      } catch (cause: unknown) {
        logger.warn('定时任务预填：时间线退订失败', { error: String(cause) })
      }
    }
  }
  return null
}

export function createAutomationsApi(ctx: UiFeatureContext): AutomationsUiApi {
  const rpc = ctx.rpc(automationsContract)
  const conversation = ctx.rpc(conversationContract)
  const platform = ctx.rpc(platformContract)

  return {
    list: () => rpc.call('automations.list', {}).then((r) => [...r.automations]),
    get: (automationId) => rpc.call('automations.get', { automationId }),
    create: (draft) => rpc.call('automations.create', draft),
    update: (automationId, patch) => rpc.call('automations.update', { automationId, patch }),
    remove: (automationId) => rpc.call('automations.remove', { automationId }).then(() => undefined),
    setEnabled: (automationId, enabled) => rpc.call('automations.setEnabled', { automationId, enabled }),
    runNow: (automationId) => rpc.call('automations.runNow', { automationId }),
    cancelRun: (runId) => rpc.call('automations.cancelRun', { runId }).then(() => undefined),
    runs: (automationId, limit) => rpc.call('automations.runs', { automationId, limit }).then((r) => [...r.runs]),
    previewSchedule: (schedule, count) => rpc.call('automations.previewSchedule', { schedule, count }),
    onChanged: (listener) => rpc.on('automations.changed', () => listener()),
    onRunUpdated: (listener) => rpc.on('automations.runUpdated', listener),
    onAttention: (listener) => rpc.on('automations.attention', listener),
    notify: async (attention) => {
      const target = attention.threadId === null ? {} : { threadId: attention.threadId }
      await platform.call('notify.show', { title: attention.title, body: attention.body, ...target })
    },
    firstUserPrompt: (thread, logger) => firstUserPrompt(conversation, thread, logger),
    draftControls: (model) => conversation.call('controls.draft', { model, thinking: null, posture: null }),
  }
}
