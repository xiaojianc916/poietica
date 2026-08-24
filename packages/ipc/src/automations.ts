import { throughIpc } from './error'
import { commands, events } from './generated/ipc-bindings'

/*
 * 自动化的读写。
 *
 * DTO 一个字都不在这里声明：原生侧的 commands/automations.rs 是权威，形状经由
 * 生成绑定过来。同包 error.ts 已经为「手抄 DTO」记过一次账 —— 手抄出来的类型
 * 编译器一个字也不会说。
 *
 * 读不到不是错误：原生侧读不动会退回空目录，所以这里没有 null 分支。
 *
 * 每一次写都按 id 寻址，并回给写完之后的整本目录：调用方不必先在本地拼一份新
 * 目录再整本发回去，也就不存在「我以为的全量」与「盘上的全量」两份真相。REST
 * 的 PUT/DELETE 与 SQL 的 UPDATE ... WHERE id = ? 都是这个形状。
 */

export type {
  Automation,
  AutomationCatalog,
  AutomationCreation,
  AutomationReschedule,
  AutomationRun,
  AutomationRunOutcome,
  AutomationRunRecord,
} from './generated/ipc-bindings'

import type {
  Automation,
  AutomationCatalog,
  AutomationCreation,
  AutomationRunRecord,
} from './generated/ipc-bindings'

export function loadAutomations(): Promise<AutomationCatalog> {
  return throughIpc(() => commands.automationsLoad())
}

/** 铸一条新的：id 与 created_at 归账本，这里送的是定义加排好的下一次。 */
export function createAutomation(creation: AutomationCreation): Promise<AutomationCatalog> {
  return throughIpc(() => commands.automationsCreate(creation))
}

/** 改写一条已有的。账本归原生侧保管，这里送的是定义。 */
export function upsertAutomation(automation: Automation): Promise<AutomationCatalog> {
  return throughIpc(() => commands.automationsUpsert(automation))
}

/** 删掉一条。已经不在的也算删成功 —— 与 HTTP DELETE 同一条语义。 */
export function removeAutomation(id: string): Promise<AutomationCatalog> {
  return throughIpc(() => commands.automationsRemove(id))
}

/** 记一次运行，并按 reschedule 推进日程。 */
export function recordAutomationRun(record: AutomationRunRecord): Promise<AutomationCatalog> {
  return throughIpc(() => commands.automationsRecordRun(record))
}

/**
 * 盯着日程：到期的那一行由原生侧递过来。
 *
 * 挂监听与「现在就看一眼」是一次操作，顺序不能反 —— Tauri 的事件不排队，先扫后挂
 * 就等于把关机期间错过的那次敲进空气里。两步合成一个函数，调用方没有把顺序写反的
 * 余地。
 *
 * 返回摘表函数。表本身不停：它在原生侧，与进程同寿。
 */
/**
 * 盯着账本：写者不只有这里，MCP 那一侧改完由原生侧宣布。返回摘表函数。
 */
export function watchAutomationCatalog(
  onChanged: (catalog: AutomationCatalog) => void,
): Promise<() => void> {
  return events.automationCatalogChanged.listen((event) => {
    onChanged(event.payload.catalog)
  })
}

export async function watchAutomations(
  onDue: (automation: Automation) => void,
): Promise<() => void> {
  const unlisten = await events.automationDue.listen((event) => {
    onDue(event.payload.automation)
  })

  await throughIpc(() => commands.automationsSweep())

  return unlisten
}
