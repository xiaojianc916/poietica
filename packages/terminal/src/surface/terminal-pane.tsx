import { warn } from '@poietica/problem'
import type { TerminalHostPort } from '@poietica/terminal'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import './terminal-pane.css'
import { terminalTheme } from './terminal-theme'

/*
 * 终端这一格。屏幕由 xterm.js 画：VTE 解析、选区、滚动回卷与网格测量都是它的既有
 * 职责。这个组件只做三件事 —— 把容器交给它、把字节两头对接、把量出来的网格报回
 * 原生侧。会话本体（PTY、子进程、回放）归原生侧，卸载不销毁。
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const FONT_SIZE = 12.5
const SCROLLBACK = 10_000
const ENCODER = new TextEncoder()

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
      cursorStyle: 'bar',
      fontFamily: MONO,
      fontSize: FONT_SIZE,
      scrollback: SCROLLBACK,
      theme: terminalTheme(element),
    })
    const fit = new FitAddon()

    terminal.loadAddon(fit)
    terminal.open(element)

    let live = true
    let stopWatching: (() => void) | null = null
    let attached = false

    const failed = (cause: unknown): void => {
      warn('终端这一格出错了', { cause, scope: 'terminal' })
    }

    /* 接不上时格子里是一片空白，看不出是坏了还是在等：把结果写进格子。 */
    const attachFailed = (cause: unknown): void => {
      failed(cause)
      terminal.write('\r\n[终端没能接上]\r\n')
    }

    const clipboardFailed = (cause: unknown): void => {
      warn('剪贴板没换成', { cause, scope: 'terminal' })
    }

    /*
     * 网格只有一个来源：容器量到的真实尺寸。量不到就不许 fit —— addon-fit 会把网格
     * 钳到 2x1，拿这个尺寸开出来的 shell 是一片空白。订阅就位、尺寸量到、还没接上，
     * 三件事凑齐才 attach，首个网格随 attach 一起过去。
     */
    const sync = (): void => {
      if (!live || stopWatching === null) {
        return
      }

      if (element.clientWidth === 0 || element.clientHeight === 0) {
        return
      }

      fit.fit()

      if (attached) {
        return
      }

      attached = true
      void port.attach(root, terminal.cols, terminal.rows).catch(attachFailed)
      terminal.focus()
    }

    /* 右键换剪贴板：有选区就复制，没选区就粘贴。xterm 在非 macOS 上不占右键。 */
    const exchangeClipboard = (event: MouseEvent): void => {
      event.preventDefault()

      if (terminal.hasSelection()) {
        const selection = terminal.getSelection()

        terminal.clearSelection()
        void navigator.clipboard.writeText(selection).catch(clipboardFailed)
        return
      }

      void navigator.clipboard.readText().then((text) => {
        if (text !== '') {
          terminal.paste(text)
        }
      }, clipboardFailed)
    }

    const listeners = [
      terminal.onData((data) => {
        void port.write(root, ENCODER.encode(data)).catch(failed)
      }),
      terminal.onResize(({ cols, rows }) => {
        if (!attached) {
          return
        }

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
        sync()
      }, attachFailed)

    const observer = new ResizeObserver(sync)

    observer.observe(element)

    /* 明暗令牌换了，画布上的颜色得跟着换：data-theme 是主题的唯一开关。 */
    const themes = new MutationObserver(() => {
      terminal.options.theme = terminalTheme(element)
    })

    themes.observe(document.documentElement, {
      attributeFilter: ['data-theme'],
      attributes: true,
    })

    element.addEventListener('contextmenu', exchangeClipboard)

    return () => {
      live = false
      observer.disconnect()
      themes.disconnect()
      element.removeEventListener('contextmenu', exchangeClipboard)
      stopWatching?.()

      for (const listener of listeners) {
        listener.dispose()
      }

      terminal.dispose()
    }
  }, [port, root])

  return <div className="h-full min-h-0 w-full bg-background" ref={host} />
}
