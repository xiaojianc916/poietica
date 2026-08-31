import type { ITheme } from '@xterm/xterm'

/*
 * xterm 画在 canvas 上，读不到 var(--x)：这一层把设计系统的 --terminal-* 令牌
 * 解析成具体颜色，那两套令牌是终端配色的唯一来源。
 */

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
  selectionBackground: '--terminal-selection',
  white: '--terminal-ansi-white',
  yellow: '--terminal-ansi-yellow',
} as const satisfies Partial<Record<keyof ITheme, string>>

/* 令牌经探针元素过一遍样式引擎再读回：交回来的是 rgb()/rgba()，xterm 只认这两种。 */
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
