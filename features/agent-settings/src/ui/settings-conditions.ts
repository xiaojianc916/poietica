/* 引擎只搬**名字**不搬求值器：判据要用此刻的设置，而那正是界面上这份目录的 `value`。名字到判据的对应逐条抄自上游正本
 * `@oh-my-pi/pi-coding-agent` 的 `config/settings-ui.ts` 的 `CONDITIONS`，只是从目录里读而不是从进程里读。认不出的名字一律**不显示**：
 * 少显示一格人看得出，多显示一格人看不出 —— 这是本模块唯一的降级方向。 */

/** 目录里按路径取此刻的值；只有非凭据的格子有值。 */
export type SettingLookup = (path: string) => unknown

/* `planModeEnabled` / `planAutosaveEnabled` 用真值判定而不是 `=== true`，与上游一致。只列**目录里还有的**条件：`vimModeEnabled` 随
 * `tui.vimMode` 一起被挡在目录外，留着它是一条永远为假的死判据。 */
const PREDICATES: Readonly<Record<string, (value: SettingLookup) => boolean>> = {
  advisorEnabled: (at) => at('advisor.enabled') === true,
  hindsightActive: (at) => at('memory.backend') === 'hindsight',
  mnemopiActive: (at) => at('memory.backend') === 'mnemopi',
  autolearnActive: (at) => at('autolearn.enabled') === true,
  autoThinkingActive: (at) => at('defaultThinkingLevel') === 'auto',
  usageAwareFallbackEnabled: (at) => at('retry.usageAwareFallback') === true,
  planModeEnabled: (at) => Boolean(at('plan.enabled')),
  planAutosaveEnabled: (at) => Boolean(at('plan.enabled')) && Boolean(at('plan.autosave')),
  macOS: () => isMacOs(),
}

/**
 * 没有条件就是显示；有条件而认不出就是**不知道**，不知道就不显示 —— 本模块唯一的降级方向。`hasImageProtocol` 是刻意留在这里的那条：
 * 上游问的是**终端**能否显示图片，这个宿主不是终端，没有答案；编一个答案就是把「画不出来」说成「画得对」。
 */
export function isVisible(condition: string | null, at: SettingLookup): boolean {
  if (condition === null) return true
  return PREDICATES[condition]?.(at) ?? false
}

function isMacOs(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/u.test(navigator.userAgent)
}
