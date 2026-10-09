import type { Posture } from '@poietica/engine'
import { overrideSetting, readSetting, type SettingsScope } from './settings-access'

/**
 * omp 知识 #13：姿态与 tools.approvalMode 的映射（12 页 §5.3），并且按会话生效。omp 用工具的能力等级（read < write < exec）与模式上限比较：
 * ask 不是“每次调用都要批准”，读类工具会自动放行。
 */
export const POSTURE_MODE: Readonly<Record<Posture, string>> = Object.freeze({
  ask: 'always-ask',
  'auto-edit': 'write',
  'full-access': 'yolo',
})

const MODE_POSTURE: Readonly<Record<string, Posture>> = Object.freeze({
  'always-ask': 'ask',
  write: 'auto-edit',
  yolo: 'full-access',
})

/** 按会话生效：写在会话设置（root.overlay()）的 override 层，不落盘、不串会话 */
export function applyPosture(scope: SettingsScope, posture: Posture): void {
  overrideSetting(scope, 'tools.approvalMode', POSTURE_MODE[posture])
}

export function readPosture(scope: SettingsScope): Posture {
  const mode = readSetting(scope, 'tools.approvalMode')
  return (typeof mode === 'string' ? MODE_POSTURE[mode] : undefined) ?? 'ask'
}

/**
 * 会话级放行：写进会话设置的 override 层。legacy 写到全局并 flush，结果“本会话允许”变成了
 * “永久允许”，这是要修正的 bug（12 页 §5.3）。
 */
export function grantToolForSession(scope: SettingsScope, tool: string): void {
  const current = readSetting(scope, 'tools.approval')
  const map = current !== null && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {}
  map[tool] = 'allow'
  overrideSetting(scope, 'tools.approval', map)
}
