import type { Logger } from '@poietica/foundation'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import type { TerminalInfo } from '../contract'
import type { TerminalApi } from './api'
import { terminalTheme } from './xterm-theme'

/*
 * 终端画面与 Host 会话之间的那一层：每个终端一个**常驻**的 xterm Terminal 对象，
 * 存在 store 之外的 Map 里（07 页 §11E）。切换标签只换哪一块 DOM 可见，对象不动 ——
 * 后台标签的输出照样写进它自己的画面，切回来时内容不缺。
 *
 * 观测、量尺寸、剪贴板与链接规则与 legacy `packages/terminal/src/surface/terminal-pane.tsx`
 * 一致（字体、字号、回卷、光标、右键换剪贴板、明暗令牌跟随）；只把数据来源从原生的
 * root 键换成契约的 terminalId。
 *
 * 07 页 §0.1 的 dependsOn 表里 terminal UI 只列了 workspaces，但 §11E 的链接一行点名
 * 要调 `shell.openExternal`（platform 契约）。两处冲突时以行为表为准：UI setup 里
 * ctx.rpc(platformContract)，index.tsx 的 dependsOn 因此是 ['workspaces', 'platform']。
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const FONT_SIZE = 12.5
const SCROLLBACK = 10_000
/** 量不到网格时的兜底（07 页 §11E「计算不出时用 120×30」） */
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30
const FIT_DEBOUNCE_MS = 50
const ENCODER = new TextEncoder()

export interface TerminalSession {
  /** 本地稳定键（React key 与 store 的键）；与 Host 的 terminalId 是两件事 */
  readonly id: string
  readonly terminal: Terminal
  readonly info: () => TerminalInfo | null
  readonly terminalId: () => string | null
  /** 把画面挂进容器：第一次 open，之后重挂只是搬回已有的 xterm DOM */
  attach(element: HTMLElement): void
  detach(): void
  /** ResizeObserver 的入口：50ms 去抖后 fit.fit() */
  scheduleFit(): void
  /** 量到网格后开 PTY（只做一次）；恢复出来的会话不重开 */
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
  /** 新建终端的 cwd：活动工作区的路径；null = 用户主目录 */
  readonly cwd: () => string | null
  /** 链接的出口：platform 契约的 shell.openExternal（07 页 §11E 的「链接」一行） */
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

  /* 右键换剪贴板：有选区就复制，没选区就粘贴（legacy 同此）。 */
  const exchangeClipboard = (event: MouseEvent): void => {
    event.preventDefault()

    if (terminal.hasSelection()) {
      writeSelection()
      return
    }

    pasteClipboard()
  }

  /*
   * 键盘剪贴板：Ctrl+Shift+C / Ctrl+Shift+V；Ctrl+C 有选区时复制、没选区时原样
   * 发给 shell（中断命令）—— 后者正是 07 页 §11E 要的双重含义，返回 true 让
   * xterm 继续处理。
   */
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
        /* 接不上时格子里是一片空白，看不出是坏了还是在等：把结果写进格子（legacy）。 */
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

      /*
       * xterm 的 open() 只能有一次；面板被卸下再挂回时，把已有的 xterm DOM
       * 搬进新容器即可（画面与回卷都在对象里，不在旧节点里）。
       */
      const opened = terminal.element

      if (opened === undefined) {
        terminal.open(next)
      } else if (opened.parentElement !== next) {
        next.append(opened)
      }

      terminal.options.theme = terminalTheme(next)
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

      /* 与 legacy 一样按字节交给 xterm：它自己的流式 UTF-8 解码器会跨块拼接。 */
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
      /* 只清 xterm 画面，不发给 shell（07 页 §11E 的 terminal.clear）。 */
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
  create(): TerminalSession
  adopt(info: TerminalInfo): TerminalSession
  get(id: string): TerminalSession | undefined
  /** 把 Host 的通知按 terminalId 分发到各自的画面 */
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

  /* data-theme 是主题的唯一开关：换了就把每个画面的颜色都换掉（legacy 每个格子一个观察者，这里一份）。 */
  const themes = new MutationObserver(() => {
    for (const session of sessions.values()) {
      session.refreshTheme()
    }
  })

  themes.observe(document.documentElement, { attributeFilter: ['data-theme'], attributes: true })

  const add = (initial: TerminalInfo | null): TerminalSession => {
    const id = `local-${++seq}`
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
    create: () => add(null),
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
