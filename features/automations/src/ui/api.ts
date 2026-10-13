import type { Controls, ModelRef } from '@poietica/engine'
import { conversationContract } from '@poietica/feature-conversation/contract'
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

export function createAutomationsApi(ctx: UiFeatureContext): AutomationsApi {
  const rpc = ctx.rpc(automationsContract)
  const conversation = ctx.rpc(conversationContract)

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
    draftControls: (model) => conversation.call('controls.draft', { model, thinking: null, posture: null }),
  }
}
