/**
 * 上次那份原生崩溃报告的形状。
 *
 * 与 apps/desktop/native 侧生成的那一份同形。
 */
export interface NativeCrashReport {
  readonly incidentId: string
  readonly occurredAt: string
  readonly message: string
  readonly backtrace: string
  readonly location: string | null
  readonly process: string
  readonly thread: string
  readonly appVersion: string
  readonly targetOs: string
  readonly targetArch: string
}

/**
 * 上一次原生进程的崩溃报告。
 *
 * 报告由原生侧在崩溃时落盘，读它也要原生侧去读 —— 渲染层没有 fs。原生组合根现在没有
 * 这条命令（diagnostics 是旧的 Tauri 组合根的模块），所以这里如实报「宿主没提供」，
 * 不兜底造一份假报告：编出来的崩溃现场比没有更坏。
 */
export function takePreviousNativeCrashReport(): Promise<NativeCrashReport | null> {
  return Promise.reject(new Error('poietica: 宿主还没有提供上一次原生崩溃报告'))
}
