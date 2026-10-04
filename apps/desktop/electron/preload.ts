/*
 * 渲染层与主进程之间唯一的一层。ipcRenderer 不出这个文件：
 * 渲染层拿到的是函数，不是通道。
 *
 * 每个 handler 都校验入参：preload 也在渲染进程里，这里收到的是不可信输入。
 * 事件名与 packages/contract/src/generated/ipc-bindings.ts 的 events 段一字不差（kebab-case，
 * 如 'browser-state'、'terminal-streamed'）；主进程负责把原生侧的 snake_case 归一成它。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'

type Unsubscribe = () => void

interface FilePickerFilter {
  readonly name: string
  readonly extensions: readonly string[]
}

interface HostBridge {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  isMaximized(): Promise<boolean>
  close(): Promise<void>
  openDevtools(): Promise<void>
  present(): Promise<void>
  openExternal(url: string): Promise<void>
  homeDirectory(): Promise<string>
  /** 这个应用自己的版本号；唯一产地是宿主（app.getVersion()）。 */
  appVersion(): Promise<string>
  pickRoot(): Promise<string | null>
  pickPaths(options: {
    multiple: boolean
    filters: readonly FilePickerFilter[]
  }): Promise<string[] | null>
  watchDroppedPaths(
    handler: (paths: readonly string[], files: readonly File[]) => void,
  ): Unsubscribe
  pickSavePath(options: {
    defaultPath: string
    filters: readonly FilePickerFilter[]
  }): Promise<string | null>
  saveExport(request: unknown): Promise<boolean>
  /** 长任务跑完时的一声；窗口在前台时宿主什么也不做。 */
  notify(request: { title: string; body: string }): Promise<void>
  setTheme(preference: 'light' | 'dark' | 'system'): Promise<'light' | 'dark'>
  setSurfaceColor(color: readonly [number, number, number]): Promise<void>
  /** 日志闸门。改一次就重开一次，不必重启应用。 */
  setLogLevel(level: string): Promise<void>
  onMaximizedChanged(handler: (isMaximized: boolean) => void): Unsubscribe
  onCloseRequested(handler: () => void): Unsubscribe
  onTerminationRequested(handler: () => void): Unsubscribe
}

interface PoieticaBridge {
  invoke(command: string, args: unknown): Promise<unknown>
  on(event: string, handler: (payload: unknown) => void): Unsubscribe
  host: HostBridge
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function invoke(channel: string, ...args: readonly unknown[]): Promise<unknown> {
  const reply: unknown = await ipcRenderer.invoke(channel, ...args)

  if (!isRecord(reply)) {
    throw new Error('poietica: internal — 主进程应答不是信封')
  }

  if (reply['ok'] === true) {
    return reply['value']
  }

  const problem = reply['problem']

  if (isRecord(problem)) {
    /*
     * 抛的是**裸对象**，不是挂着 problem 的 Error。
     *
     * contextBridge 只搬运结构化克隆得动的东西，而 Error 的自定义属性过不去：实测
     * `Object.getOwnPropertyNames(thrown)` 只剩 `['stack','message']`，`problem` 整格丢失。
     * 于是 throughIpc 那两处 `isProblem` 都认不出来（packages/native-bridge/src/ipc-error.ts），
     * 屏幕上是 `Error: poietica: agentRejected` 这样一句码 —— 而 details.reason 才是原因。
     *
     * 裸对象是结构化克隆的原生支持，过桥后形状不变（`isProblem` 本来就按形状认）。
     * 代价只有一个：它带得出码，带不出栈 —— 而栈在原生侧与日志里都有，码在渲染层没有替身。
     */
    throw problem
  }

  throw new Error(typeof reply['message'] === 'string' ? reply['message'] : 'poietica: internal')
}

function subscribe(channel: string, forward: (payload: unknown) => void): Unsubscribe {
  const listener = (_event: unknown, payload: unknown): void => {
    forward(payload)
  }

  ipcRenderer.on(channel, listener)

  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/** 通道名与命令名分开：命令名由原生决定，通道名是宿主自己的事。 */
function commandChannel(): string {
  return 'poietica:invoke'
}

function isSurfaceColor(value: unknown): value is readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    return false
  }

  return value.every(
    (part) => typeof part === 'number' && Number.isInteger(part) && part >= 0 && part <= 255,
  )
}

function pickerFilters(value: unknown): FilePickerFilter[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const filters: FilePickerFilter[] = []

  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry['name'] !== 'string' ||
      !Array.isArray(entry['extensions'])
    ) {
      return null
    }

    const extensions = entry['extensions'].filter(
      (item): item is string => typeof item === 'string',
    )

    filters.push({ name: entry['name'], extensions })
  }

  return filters
}

const bridge: PoieticaBridge = {
  invoke(command, args) {
    if (typeof command !== 'string' || command.length === 0) {
      return Promise.reject(new Error('poietica: requestInvalid — 命令名必须是非空字符串'))
    }

    return invoke(commandChannel(), command, args ?? null)
  },

  on(event, handler) {
    if (typeof event !== 'string' || event.length === 0 || typeof handler !== 'function') {
      throw new Error('poietica: requestInvalid — 事件名必须是非空字符串且要有处理函数')
    }

    return subscribe(`poietica:event:${event}`, handler)
  },

  host: {
    minimize: () => invoke('poietica:window', 'minimize').then(() => undefined),
    toggleMaximize: () => invoke('poietica:window', 'toggleMaximize').then(() => undefined),
    isMaximized: () => invoke('poietica:window', 'isMaximized').then((value) => value === true),
    close: () => invoke('poietica:window', 'close').then(() => undefined),
    openDevtools: () => invoke('poietica:window', 'openDevtools').then(() => undefined),
    present: () => invoke('poietica:window', 'present').then(() => undefined),

    openExternal(url) {
      if (typeof url !== 'string' || url.length === 0) {
        return Promise.reject(new Error('poietica: requestInvalid — 打开的地址必须是非空字符串'))
      }

      return invoke('poietica:open-external', url).then(() => undefined)
    },

    homeDirectory: () => invoke('poietica:home-directory').then((value) => String(value)),

    appVersion: () => invoke('poietica:app-version').then((value) => String(value)),

    pickRoot: () =>
      invoke('poietica:pick-root').then((value) => (typeof value === 'string' ? value : null)),

    pickPaths(options) {
      if (!isRecord(options) || typeof options['multiple'] !== 'boolean') {
        return Promise.reject(new Error('poietica: requestInvalid — 挑文件要说明能不能多选'))
      }

      const filters = pickerFilters(options['filters'])

      if (filters === null) {
        return Promise.reject(
          new Error('poietica: requestInvalid — 过滤器要写成 { name, extensions[] }'),
        )
      }

      return invoke('poietica:pick-paths', { multiple: options['multiple'], filters }).then(
        (value) =>
          Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string')
            : null,
      )
    },

    watchDroppedPaths(handler) {
      if (typeof handler !== 'function') {
        throw new Error('poietica: requestInvalid — 拖放要有个处理函数')
      }

      /*
       * 这条只能在 preload：File.path 在 Electron 32 之后没了，路径只有
       * webUtils.getPathForFile 拿得到。
       *
       * 没有路径的那些也一起交出去：截图、剪贴板拖出来的临时物、任何不在盘上的字节，
       * 平台只给 File 本身。它是可克隆的，过得了 contextBridge —— 渲染层按字节收下，
       * 别处已经在走同一条路（粘贴）。
       */
      const onDrop = (event: DragEvent): void => {
        event.preventDefault()

        const files = [...(event.dataTransfer?.files ?? [])]
        const paths: string[] = []
        const loose: File[] = []

        for (const file of files) {
          const path = webUtils.getPathForFile(file)

          if (path.length > 0) {
            paths.push(path)
          } else {
            loose.push(file)
          }
        }

        if (paths.length > 0) {
          handler(paths, [])
        }

        if (loose.length > 0) {
          handler([], loose)
        }
      }

      const swallow = (event: DragEvent): void => {
        event.preventDefault()
      }

      window.addEventListener('dragover', swallow)
      window.addEventListener('drop', onDrop)

      return () => {
        window.removeEventListener('dragover', swallow)
        window.removeEventListener('drop', onDrop)
      }
    },

    pickSavePath(options) {
      if (!isRecord(options) || typeof options['defaultPath'] !== 'string') {
        return Promise.reject(new Error('poietica: requestInvalid — 保存对话框要说明默认文件名'))
      }

      const filters = pickerFilters(options['filters'])

      if (filters === null) {
        return Promise.reject(
          new Error('poietica: requestInvalid — 过滤器要写成 { name, extensions[] }'),
        )
      }

      return invoke('poietica:pick-save-path', {
        defaultPath: options['defaultPath'],
        filters,
      }).then((value) => (typeof value === 'string' ? value : null))
    },

    saveExport: (request) =>
      invoke('poietica:save-export', request).then((value) => value === true),

    notify(request) {
      if (!isRecord(request) || typeof request['title'] !== 'string') {
        return Promise.reject(new Error('poietica: requestInvalid — 通知要有 title 与 body'))
      }

      return invoke('poietica:notify', { title: request['title'], body: request['body'] }).then(
        () => undefined,
      )
    },

    setTheme(preference) {
      if (preference !== 'light' && preference !== 'dark' && preference !== 'system') {
        return Promise.reject(
          new Error('poietica: requestInvalid — 主题偏好只有 light/dark/system'),
        )
      }

      return invoke('poietica:set-theme', preference).then((value) =>
        value === 'dark' ? 'dark' : 'light',
      )
    },

    setSurfaceColor(color) {
      if (!isSurfaceColor(color)) {
        return Promise.reject(new Error('poietica: requestInvalid — 底色是三个 0-255 的整数'))
      }

      return invoke('poietica:set-surface', color).then(() => undefined)
    },

    setLogLevel(level) {
      if (typeof level !== 'string' || level.length === 0) {
        return Promise.reject(new Error('poietica: requestInvalid — 日志级别必须是非空字符串'))
      }

      return invoke('poietica:set-log-level', level).then(() => undefined)
    },

    onMaximizedChanged(handler) {
      return subscribe('poietica:window-maximized', (payload) => {
        handler(payload === true)
      })
    },

    onCloseRequested(handler) {
      return subscribe('poietica:close-requested', () => {
        handler()
      })
    },

    onTerminationRequested(handler) {
      return subscribe('poietica:termination-requested', () => {
        handler()
      })
    },
  },
}

contextBridge.exposeInMainWorld('poietica', bridge)
