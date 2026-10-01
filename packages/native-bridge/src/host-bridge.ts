/*
 * 宿主端口：Electron 主进程在 preload 里装的那一份 window.poietica。
 *
 * 形状与 apps/desktop/electron/preload.ts 的 PoieticaBridge 一致。这个文件是渲染层唯一
 * 能看见宿主的地方，别处出现 window.poietica 即为缺陷。
 */
export interface PoieticaHostBridge {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  isMaximized(): Promise<boolean>
  close(): Promise<void>
  openDevtools(): Promise<void>
  openExternal(url: string): Promise<void>
  /** 用户主目录。无项目工作区没有指定根时退到它。 */
  homeDirectory(): Promise<string>
  pickRoot(): Promise<string | null>
  pickPaths(options: {
    readonly multiple: boolean
    readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[]
  }): Promise<string[] | null>
  saveExport(request: unknown): Promise<boolean>
  setSurfaceColor(color: readonly [number, number, number]): Promise<void>
  setTheme(preference: 'light' | 'dark' | 'system'): Promise<'light' | 'dark'>
  present(): Promise<void>
  appVersion(): Promise<string>
  watchDroppedPaths(handler: (paths: readonly string[]) => void): () => void
  onMaximizedChanged(handler: (isMaximized: boolean) => void): () => void
  onCloseRequested(handler: () => void): () => void
  onTerminationRequested(handler: () => void): () => void
}

export interface PoieticaBridge {
  invoke(command: string, args: unknown): Promise<unknown>
  /** 事件名是宿主转发时用的线上名（snake_case），订阅返回同步的卸载函数。 */
  on(event: string, handler: (payload: unknown) => void): () => void
  host: PoieticaHostBridge
}

/**
 * 宿主端口。
 *
 * 断言安全：生成物的 declare global 只声明了 invoke 与 on，host 那一面是 preload 装的
 * 同一个对象的字段；这里补上它的形状。preload 一定先于页面脚本跑完，拿不到它就是构建
 * 或装载错了，早炸好过一路 undefined。
 */
export function hostBridge(): PoieticaBridge {
  const bridge = window.poietica as PoieticaBridge | undefined

  if (bridge === undefined) {
    throw new Error('poietica: 宿主端口没装上 —— preload 没有跑起来')
  }

  return bridge
}
