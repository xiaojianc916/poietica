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
  watchDroppedPaths(handler: (paths: readonly string[]) => void): Unsubscribe
  saveExport(request: unknown): Promise<boolean>
  setTheme(preference: 'light' | 'dark' | 'system'): Promise<'light' | 'dark'>
  setSurfaceColor(color: readonly [number, number, number]): Promise<void>
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
    // 裸对象照原样上抛：packages/problem 的 isProblem 只按形状认。
    throw Object.assign(new Error(`poietica: ${String(problem['code'])}`), { problem })
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

      // 这条只能在 preload：File.path 在 Electron 32 之后没了，路径只有 webUtils.getPathForFile 拿得到，
      // 而 File 对象过不了 contextBridge。所以事件在这里听，路径在这里换，渲染层只收字符串。
      const onDrop = (event: DragEvent): void => {
        event.preventDefault()

        const paths = [...(event.dataTransfer?.files ?? [])].flatMap((file) => {
          const path = webUtils.getPathForFile(file)

          return path.length > 0 ? [path] : []
        })

        if (paths.length > 0) {
          handler(paths)
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

    saveExport: (request) =>
      invoke('poietica:save-export', request).then((value) => value === true),

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
