import { warn } from '@poietica/problem'
import type { TerminalHostPort } from '@poietica/terminal'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'

/*
 * 终端这一格。
 *
 * 屏幕由 xterm.js 画：VTE 解析、选区、滚动回卷、链接、无障碍与网格测量都是它的
 * 既有职责，手搓一份必漏边界。这个组件只做三件事 —— 把容器交给它、把字节两头对接、
 * 把量出来的网格报回原生侧。会话本体（PTY、子进程、回放）归原生侧，卸载不销毁。
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const FONT_SIZE = 12.5
const SCROLLBACK = 10_000
const ENCODER = new TextEncoder()

/* ANSI 十六色，深浅两套同色相：各自在对面的底色上仍然读得清。 */
type Ansi16 = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
]

const ANSI_DARK: Ansi16 = [
  '#1d1f21',
  '#cc6666',
  '#b5bd68',
  '#f0c674',
  '#81a2be',
  '#b294bb',
  '#8abeb7',
  '#c5c8c6',
  '#666666',
  '#d54e53',
  '#b9ca4a',
  '#e7c547',
  '#7aa6da',
  '#c397d8',
  '#70c0b1',
  '#eaeaea',
]
const ANSI_LIGHT: Ansi16 = [
  '#000000',
  '#c82829',
  '#718c00',
  '#eab700',
  '#4271ae',
  '#8959a8',
  '#3e999f',
  '#c7c7c7',
  '#8e908c',
  '#c82829',
  '#718c00',
  '#eab700',
  '#4271ae',
  '#8959a8',
  '#3e999f',
  '#ffffff',
]

function channels(color: string): readonly number[] {
  return (color.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/* 底色的亮度决定用哪套 ANSI：主题换了这里跟着换，不另存一份主题状态。 */
function isDark(background: readonly number[]): boolean {
  const [red = 0, green = 0, blue = 0] = background

  return (red * 299 + green * 587 + blue * 114) / 1000 < 128
}

function terminalTheme(element: HTMLElement) {
  const computed = getComputedStyle(element)
  const palette = isDark(channels(computed.backgroundColor)) ? ANSI_DARK : ANSI_LIGHT
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = palette

  return {
    background: computed.backgroundColor,
    black,
    blue,
    brightBlack,
    brightBlue,
    brightCyan,
    brightGreen,
    brightMagenta,
    brightRed,
    brightWhite,
    brightYellow,
    cursor: computed.color,
    cyan,
    foreground: computed.color,
    green,
    magenta,
    red,
    white,
    yellow,
  }
}

export interface TerminalPaneProps {
  readonly port: TerminalHostPort
  /** 会话键，也就是这条对话的工作目录。 */
  readonly root: string
}

export function TerminalPane({ port, root }: TerminalPaneProps) {
  const host = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = host.current

    if (element === null) {
      return undefined
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: MONO,
      fontSize: FONT_SIZE,
      scrollback: SCROLLBACK,
      theme: terminalTheme(element),
    })
    const fit = new FitAddon()

    terminal.loadAddon(fit)
    terminal.open(element)
    fit.fit()
    terminal.focus()

    let live = true
    let stopWatching: (() => void) | null = null

    const failed = (cause: unknown): void => {
      warn('终端这一格没接上', { cause, scope: 'terminal' })
    }

    const listeners = [
      terminal.onData((data) => {
        void port.write(root, ENCODER.encode(data)).catch(failed)
      }),
      terminal.onResize(({ cols, rows }) => {
        void port.resize(root, cols, rows).catch(failed)
      }),
    ]

    /* 先订阅再接上：回放是这个通道上的第一批字节，顺序由原生侧的回放锁保证。 */
    void port
      .watch(root, (signal) => {
        if (!live) {
          return
        }

        if (signal.kind === 'output') {
          terminal.write(signal.bytes)
          return
        }

        terminal.write('\r\n[shell 已退出]\r\n')
      })
      .then((dispose) => {
        if (!live) {
          dispose()
          return
        }

        stopWatching = dispose

        void port.attach(root, terminal.cols, terminal.rows).catch(failed)
      }, failed)

    /* 拖宽与开合都只改容器尺寸：量在这里发生一次，网格由 fit 算。 */
    const observer = new ResizeObserver(() => {
      fit.fit()
    })

    observer.observe(element)

    return () => {
      live = false
      observer.disconnect()
      stopWatching?.()

      for (const listener of listeners) {
        listener.dispose()
      }

      terminal.dispose()
    }
  }, [port, root])

  return <div className="h-full min-h-0 w-full bg-background" ref={host} />
}
