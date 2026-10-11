import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { type SettingsScope, settingAt } from '../settings-access'

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

/** 读一格模型角色（omp 的 Settings.getModelRole）；没配就是 undefined。 */
export function modelRoleOf(scope: SettingsScope, role: string): string | undefined {
  return settingsInstanceOf(scope).getModelRole(role)
}

/** 写/删一格模型角色（omp 的 Settings.setModelRole；undefined 是删除）。 */
export function setModelRoleOf(scope: SettingsScope, role: string, value: string | undefined): void {
  settingsInstanceOf(scope).setModelRole(role, value)
}

/** 覆盖整份模型角色表（omp 的 Settings.overrideModelRoles，只写运行时覆盖层）。 */
export function overrideModelRolesOf(scope: SettingsScope, roles: Readonly<Record<string, string>>): void {
  settingsInstanceOf(scope).overrideModelRoles(roles)
}

/**
 * 把设置写盘。SettingsScope 是「持有 Settings 的对象」或 Settings 本身（registry.ts 的
 * ScopeLike）；flush 挂在 Settings 实例上，所以这里做一次收窄。
 */
export async function flushOf(scope: SettingsScope): Promise<void> {
  await settingsInstanceOf(scope).flush()
}

function settingsInstanceOf(scope: SettingsScope): Settings {
  return 'settings' in scope ? scope.settings : scope
}

/** omp 的数组句柄那一格（Setting.setMember）。 */
interface MemberHandle {
  setMember(scope: SettingsScope, item: string, options: { member: boolean }): void
}

function entryOf(path: string): MemberHandle {
  return settingAt(path) as unknown as MemberHandle
}

function setMember(scope: SettingsScope, path: string, item: string, member: boolean): void {
  entryOf(path).setMember(scope, item, { member })
}
