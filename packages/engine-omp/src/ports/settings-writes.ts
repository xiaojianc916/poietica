import { readSetting, type SettingsScope, settingAt } from '../settings-access'

/*
 * 端口要用到、而 settings-access.ts（P2.4，别人的线）没导出的那几件设置操作。
 * 收在这里而不是回头去改那个文件：端口只写 ports/**（task-6 的写范围），
 * 而 settings-access 的 settingAt 已经是全仓唯一的路径解析点 —— 这里从它出发，不自己 lookup。
 */

/** 设置句柄的 schema 类型（boolean / enum / number / string / array / record）。 */
export function settingTypeOf(path: string): string {
  return (settingAt(path) as unknown as { type: string }).type
}

/** 数组设置加一项（omp 的 Setting.setMember 只认 { member: boolean } 这一种形状）。 */
export function addArrayMember(scope: SettingsScope, path: string, item: string): void {
  setMember(scope, path, item, true)
}

/** 数组设置删一项。 */
export function removeArrayMember(scope: SettingsScope, path: string, item: string): void {
  setMember(scope, path, item, false)
}

/** record 设置里的一格（omp 的 Setting.setEntry）。 */
export function writeRecordEntry(scope: SettingsScope, path: string, key: string, value: unknown): void {
  entryOf(path).setEntry(scope, key, value as never)
}

/** 读 record 设置里的一格；那一格不存在就是 undefined。 */
export function readRecordEntry(scope: SettingsScope, path: string, key: string): unknown {
  const record: unknown = readSetting(scope, path)
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
  return (record as Record<string, unknown>)[key]
}

/**
 * 把设置写盘。SettingsScope 是「持有 Settings 的对象」或 Settings 本身（registry.ts 的
 * ScopeLike）；flush 挂在 Settings 实例上，所以这里做一次收窄。
 */
export async function flushOf(scope: SettingsScope): Promise<void> {
  await settingsInstanceOf(scope).flush()
}

function settingsInstanceOf(scope: SettingsScope): { flush(): Promise<void> } {
  return 'settings' in scope ? scope.settings : scope
}

/** omp 的数组/record 句柄那几格（Setting.setMember / Setting.setEntry）。 */
interface MemberHandle {
  setMember(scope: SettingsScope, item: string, options: { member: boolean }): void
  setEntry(scope: SettingsScope, key: string, value: never): void
}

function entryOf(path: string): MemberHandle {
  return settingAt(path) as unknown as MemberHandle
}

function setMember(scope: SettingsScope, path: string, item: string, member: boolean): void {
  entryOf(path).setMember(scope, item, { member })
}
