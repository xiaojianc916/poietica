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

/*
 * `ctx.rpc(automationsContract)` 的薄封装（与 terminal / usage / review 的 ui/api.ts 同形）。
 *
 * legacy 的 AutomationGateway 有 loadCatalog / watchCatalog 两个整册读法，因为 Rust 侧
 * 把「任务定义 + 运行记录 + revision」装成一个目录快照。新契约是 07 页 §9 逐方法给出的：
 * 列表、单条读取、runs 分页、invalidation 通知（changed / runUpdated）分开。
 * 界面因此不再认识「目录快照」这个概念，只按方法名取数。
 */

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
  /** 一次运行需要告诉用户（审查 R-16：Core 判，这里只转成系统通知） */
  onAttention(listener: (attention: AutomationAttention) => void): { dispose(): void }
  /**
   * 模型与思考强度的可选项（审查 R-16）：conversation 的 `controls.draft`（只读、不开会话）。
   * 给了 model 时 thinking.choices 是那个模型的档位。
   */
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
