import type { Logger } from '@poietica/foundation'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import type { TerminalInfo } from '../contract'
import type { TerminalApi } from './api'
import { terminalTheme } from './xterm-theme'

import '@xterm/xterm/css/xterm.css'
/* 必须排在 xterm.css 之后、同一个分块里：两边有同特异性的规则（`.xterm .xterm-viewport`），谁后到谁赢。面板本身进了首屏，
 * 这份覆盖要是跟着面板走，就会比按需加载的 xterm.css 先到、反被它盖掉（露黑边、多一条原生滚动条）。 */
import './terminal-pane.css'

/* 每个终端一个**常驻**的 xterm Terminal 对象，存在 store 之外的 Map 里。切换标签只换哪一块 DOM 可见，对象不动 —— 后台标签的
 * 输出照样写进它自己的画面，切回来时内容不缺。观测、量尺寸、剪贴板与链接规则与 legacy 一致，只把数据来源从原生 root 键换成
 * 契约的 terminalId。dependsOn 是 ['workspaces', 'platform']：platform 来自「链接」一行要调 shell.openExternal。 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const FONT_SIZE = 12.5
const SCROLLBACK = 10_000
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30
const FIT_DEBOUNCE_MS = 50
const ENCODER = new TextEncoder()

export interface TerminalSession {
  readonly id: string
  readonly terminal: Terminal
  readonly info: () => TerminalInfo | null
  readonly terminalId: () => string | null
  attach(element: HTMLElement): void
  detach(): void
  scheduleFit(): void
  spawnIfNeeded(): void
  write(data: string): void
  markExited(exitCode: number | null): void
  exchangeClipboard(event: MouseEvent): void
  clear(): void
  focus(): void
  refreshTheme(): void
  dispose(): void
}

export interface TerminalSessionDeps {
  readonly api: TerminalApi
  readonly logger: Logger
  readonly cwd: () => string | null
  readonly openExternal: (url: string) => void
  readonly onInfo: (sessionId: string, info: TerminalInfo) => void
  readonly onError: (error: unknown, title: string) => void
}

export function createTerminalSession(
  id: string,
  d: TerminalSessionDeps,
  initial: TerminalInfo | null,
): TerminalSession {
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: MONO,
    fontSize: FONT_SIZE,
    scrollback: SCROLLBACK,
    theme: {},
  })
  const fit = new FitAddon()

  terminal.loadAddon(fit)
  terminal.loadAddon(
    /* 链接一律交给系统默认浏览器（platform 的 shell.openExternal 只放行 http(s)/mailto）。 */
    new WebLinksAddon((_event, uri) => {
      d.openExternal(uri)
    }),
  )

  let element: HTMLElement | null = null
  let info: TerminalInfo | null = initial
  let spawning = false
  let disposed = false
  let fitTimer: ReturnType<typeof setTimeout> | undefined
  let lastCols: number | null = null
  let lastRows: number | null = null

  const failed = (cause: unknown): void => {
    d.logger.warn('终端动作失败', { sessionId: id, error: String(cause) })
  }
  const clipboardFailed = (cause: unknown): void => {
    d.logger.warn('剪贴板没换成', { sessionId: id, error: String(cause) })
  }

  const writeSelection = (): void => {
    const selection = terminal.getSelection()

    if (selection === '') {
      return
    }

    terminal.clearSelection()
    void navigator.clipboard.writeText(selection).catch(clipboardFailed)
  }

  const pasteClipboard = (): void => {
    void navigator.clipboard.readText().then((text) => {
      if (text !== '') {
        terminal.paste(text)
      }
    }, clipboardFailed)
  }

  const exchangeClipboard = (event: MouseEvent): void => {
    event.preventDefault()

    if (terminal.hasSelection()) {
      writeSelection()
      return
    }

    pasteClipboard()
  }

  /* Ctrl+C 有选区时复制、没选区时原样发给 shell（中断命令），返回 true 让 xterm 继续处理。 */
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) {
      return true
    }

    if (event.shiftKey && event.code === 'KeyC') {
      writeSelection()
      return false
    }

    if (event.shiftKey && event.code === 'KeyV') {
      pasteClipboard()
      return false
    }

    if (!event.shiftKey && event.code === 'KeyC' && terminal.hasSelection()) {
      writeSelection()
      return false
    }

    return true
  })

  terminal.onData((data) => {
    if (info === null || disposed) {
      return
    }

    void d.api.write(info.terminalId, data).catch(failed)
  })

  const spawnIfNeeded = (): void => {
    if (disposed || spawning || info !== null || element === null) {
      return
    }

    const dims = fit.proposeDimensions()
    const cols = dims?.cols ?? DEFAULT_COLS
    const rows = dims?.rows ?? DEFAULT_ROWS

    spawning = true
    void d.api.open({ cwd: d.cwd(), cols, rows }).then(
      (opened) => {
        spawning = false
        if (disposed) {
          void d.api.close(opened.terminalId).catch(failed)
          return
        }
        info = opened
        lastCols = cols
        lastRows = rows
        terminal.focus()
        d.onInfo(id, opened)
      },
      (cause: unknown) => {
        spawning = false
        terminal.write('\r\n[终端没能接上]\r\n')
        d.onError(cause, '终端没能接上')
      },
    )
  }

  const applyFit = (): void => {
    if (disposed || element === null || element.clientWidth === 0 || element.clientHeight === 0) {
      return
    }

    fit.fit()
    spawnIfNeeded()

    if (info === null) {
      return
    }

    if (terminal.cols !== lastCols || terminal.rows !== lastRows) {
      lastCols = terminal.cols
      lastRows = terminal.rows
      void d.api.resize(info.terminalId, terminal.cols, terminal.rows).catch(failed)
    }
  }

  return {
    id,
    terminal,
    info: () => info,
    terminalId: () => info?.terminalId ?? null,
    attach(next) {
      if (disposed) {
        return
      }

      element = next
      next.addEventListener('contextmenu', exchangeClipboard)

      /* 先上色再 open：open 之后的第一帧就按主题画，不先拿 xterm 的默认黑底垫一下。 */
      terminal.options.theme = terminalTheme(next)

      /* xterm 的 open() 只能有一次；重挂时把已有的 xterm DOM 搬进新容器即可 —— 画面与回卷都在对象里，不在旧节点里。 */
      const opened = terminal.element

      if (opened === undefined) {
        terminal.open(next)
      } else if (opened.parentElement !== next) {
        next.append(opened)
      }

      applyFit()
    },
    detach() {
      element?.removeEventListener('contextmenu', exchangeClipboard)
      element = null
    },
    scheduleFit() {
      if (disposed) {
        return
      }

      if (fitTimer !== undefined) {
        clearTimeout(fitTimer)
      }

      fitTimer = setTimeout(() => {
        fitTimer = undefined
        applyFit()
      }, FIT_DEBOUNCE_MS)
    },
    spawnIfNeeded,
    write(data) {
      if (disposed || data.length === 0) {
        return
      }

      /* 按字节交给 xterm：它自己的流式 UTF-8 解码器会跨块拼接。 */
      terminal.write(ENCODER.encode(data))
    },
    markExited(exitCode) {
      if (info !== null) {
        info = { ...info, exited: true, exitCode }
      }

      terminal.write('\r\n[shell 已退出]\r\n')

      if (info !== null) {
        d.onInfo(id, info)
      }
    },
    exchangeClipboard,
    clear() {
      terminal.clear()
    },
    focus() {
      terminal.focus()
    },
    refreshTheme() {
      if (!disposed) {
        terminal.options.theme = terminalTheme(element ?? document.documentElement)
      }
    },
    dispose() {
      if (disposed) {
        return
      }

      disposed = true

      if (fitTimer !== undefined) {
        clearTimeout(fitTimer)
      }

      element?.removeEventListener('contextmenu', exchangeClipboard)
      element = null
      terminal.dispose()
    },
  }
}

export interface TerminalSessions {
  /** id 缺省时按 `local-N` 自己编；给了就用它（加载壳先上了标签的那一格） */
  create(id?: string): TerminalSession
  adopt(info: TerminalInfo): TerminalSession
  get(id: string): TerminalSession | undefined
  writeToHost(hostId: string, data: string): void
  markHostExited(hostId: string, exitCode: number | null): void
  hasHost(hostId: string): boolean
  dispose(id: string): void
  disposeAll(): void
}

export function createTerminalSessions(d: TerminalSessionDeps): TerminalSessions {
  const sessions = new Map<string, TerminalSession>()
  const byHost = new Map<string, string>()
  let seq = 0

  /* data-theme 是主题的唯一开关：换了就把每个画面的颜色都换掉。 */
  const themes = new MutationObserver(() => {
    for (const session of sessions.values()) {
      session.refreshTheme()
    }
  })

  themes.observe(document.documentElement, { attributeFilter: ['data-theme'], attributes: true })

  const add = (initial: TerminalInfo | null, given?: string): TerminalSession => {
    const id = given ?? `local-${++seq}`
    const session = createTerminalSession(
      id,
      {
        ...d,
        onInfo: (sessionId, info) => {
          byHost.set(info.terminalId, sessionId)
          d.onInfo(sessionId, info)
        },
      },
      initial,
    )

    if (initial !== null) {
      byHost.set(initial.terminalId, id)
    }

    sessions.set(id, session)
    return session
  }

  return {
    create: (id) => add(null, id),
    adopt: (info) => add(info),
    get: (id) => sessions.get(id),
    writeToHost(hostId, data) {
      const id = byHost.get(hostId)

      if (id !== undefined) {
        sessions.get(id)?.write(data)
      }
    },
    markHostExited(hostId, exitCode) {
      const id = byHost.get(hostId)

      if (id !== undefined) {
        sessions.get(id)?.markExited(exitCode)
      }
    },
    hasHost: (hostId) => byHost.has(hostId),
    dispose(id) {
      const session = sessions.get(id)

      if (session === undefined) {
        return
      }

      const hostId = session.terminalId()
      sessions.delete(id)

      if (hostId !== null) {
        byHost.delete(hostId)
        void d.api.close(hostId).catch((cause: unknown) => {
          d.onError(cause, '终端没能关掉')
        })
      }

      session.dispose()
    },
    disposeAll() {
      themes.disconnect()
      for (const session of [...sessions.values()]) {
        const hostId = session.terminalId()

        if (hostId !== null) {
          void d.api.close(hostId).catch(() => undefined)
        }

        session.dispose()
      }
      sessions.clear()
      byHost.clear()
    },
  }
}
