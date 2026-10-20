import type { TerminalInfo } from '../contract'

/* 标签条与面板要画的那几样字段，以及由它们推出来的标签名。单列一个文件是因为它们要进**首屏**（右坞标签条在 xterm 加载之前就得画出
 * 「终端」那一格），而 terminal-store.ts 一 import 就把 xterm 带进来 —— 这里只许依赖契约的类型。 */

export interface TerminalEntry {
  readonly id: string
  readonly info: TerminalInfo | null
}

export interface TerminalUiState {
  readonly terminals: readonly TerminalEntry[]
  readonly activeId: string | null
}

export const INITIAL_TERMINAL_UI: TerminalUiState = { terminals: [], activeId: null }

export function terminalOrdinal(terminalId: string): number {
  const n = Number.parseInt(terminalId.slice(1), 10)
  return Number.isFinite(n) ? n : 0
}

export function terminalTabLabel(entry: TerminalEntry): string {
  if (entry.info === null) {
    return '终端'
  }

  if (entry.info.exited) {
    return entry.info.exitCode === null ? '已退出' : `已退出 (${entry.info.exitCode})`
  }

  return `${entry.info.title} • ${terminalOrdinal(entry.info.terminalId)}`
}
