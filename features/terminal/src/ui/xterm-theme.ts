import type { ITheme } from '@xterm/xterm'

/* xterm 画在 canvas 上读不到 var(--x)：这一层把设计系统的 --terminal-* 令牌解析成具体颜色，那两套令牌是终端配色的唯一来源。 */

const SLOTS = {
  background: '--terminal-background',
  black: '--terminal-ansi-black',
  blue: '--terminal-ansi-blue',
  brightBlack: '--terminal-ansi-bright-black',
  brightBlue: '--terminal-ansi-bright-blue',
  brightCyan: '--terminal-ansi-bright-cyan',
  brightGreen: '--terminal-ansi-bright-green',
  brightMagenta: '--terminal-ansi-bright-magenta',
  brightRed: '--terminal-ansi-bright-red',
  brightWhite: '--terminal-ansi-bright-white',
  brightYellow: '--terminal-ansi-bright-yellow',
  cursor: '--terminal-cursor',
  cyan: '--terminal-ansi-cyan',
  foreground: '--terminal-foreground',
  green: '--terminal-ansi-green',
  magenta: '--terminal-ansi-magenta',
  red: '--terminal-ansi-red',
  /* xterm 默认按「前景色兑 20/40/50% 不透明度」自己算，那是系统条的观感；这里改成产品那条 —— 深浅两档实色 + 悬停一档，取的是全仓
   * 唯一一份滚动条令牌（design-system/src/scrollbar.css）。 */
  scrollbarSliderActiveBackground: '--ui-scrollbar-thumb-hover',
  scrollbarSliderBackground: '--ui-scrollbar-thumb',
  scrollbarSliderHoverBackground: '--ui-scrollbar-thumb-hover',
  selectionBackground: '--terminal-selection',
  white: '--terminal-ansi-white',
  yellow: '--terminal-ansi-yellow',
} as const satisfies Partial<Record<keyof ITheme, string>>

export function terminalTheme(host: HTMLElement): ITheme {
  const probe = document.createElement('span')

  probe.style.display = 'none'
  host.append(probe)

  const computed = getComputedStyle(probe)
  const theme: ITheme = {}

  try {
    for (const [slot, token] of Object.entries(SLOTS)) {
      if (computed.getPropertyValue(token) === '') {
        continue
      }

      probe.style.color = `var(${token})`
      theme[slot as keyof typeof SLOTS] = computed.color
    }
  } finally {
    probe.remove()
  }

  return theme
}
