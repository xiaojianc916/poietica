import type {
  Automation,
  AutomationCatalog,
  AutomationCreation,
  AutomationRunRecord,
} from '@poietica/contract'

/**
 * 自动化账本的端口：领域不认识 IPC，由组合根注入 native-bridge 的实现。
 *
 * 形状与 @poietica/native-bridge 的 gateways/automations.ts 一一对应 —— 那一层
 * 实现、这一层消费，写路径因此只有一条。
 */
export interface AutomationGateway {
  loadCatalog(): Promise<AutomationCatalog>
  create(creation: AutomationCreation): Promise<AutomationCatalog>
  upsert(automation: Automation): Promise<AutomationCatalog>
  remove(id: string): Promise<AutomationCatalog>
  recordRun(record: AutomationRunRecord): Promise<AutomationCatalog>
  /** 盯账本：写者不只有这里，原生侧写完会宣布。返回摘表函数。 */
  watchCatalog(onChanged: (catalog: AutomationCatalog) => void): Promise<() => void>
  /** 盯日程：到期的那一行由原生侧递过来。挂监听与首扫是一次操作。 */
  watchDue(onDue: (automation: Automation) => void): Promise<() => void>
}
