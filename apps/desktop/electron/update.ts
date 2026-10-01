/*
 * 出货更新：update_check / update_download / update_relaunch 三条命令的唯一实现。
 *
 * 更新是宿主能力 —— electron-updater 要 app、process.resourcesPath 与安装包，原生侧
 * 一样都没有。所以它们与 browser_* 同类：命令名进主进程自己的表，不进 Rust 的命令
 * 清单（apps/desktop/native/src/ipc/mod.rs），否则契约里会多出三条永远报错的空壳。
 *
 * 装载推迟到第一次调用：启动路径上没有更新这件事，没理由为每次启动把 electron-updater
 * 连它的依赖图一起拉进来。未打包时没有 app-update.yml，那也只在人真的点了检查时才
 * 变成一次失败，主进程照常起来。
 */

/**
 * electron-updater 的 autoUpdater 里真正用到的三个动作；做成端口是为了让自检不碰 electron。
 *
 * checkForUpdates 的结果照抄 electron-updater：**没有新版本时它不返回 null**，而是回一个
 * isUpdateAvailable: false 的结果（null 只出现在更新器被停用时）。把 false 当成「有新版本」
 * 会报一个根本下载不下来的版本 —— 那一轮的 updateInfoAndProvider 没被记下，
 * downloadUpdate 当场抛「Please check update first」。
 */
export interface UpdaterPort {
  checkForUpdates(): Promise<{
    readonly isUpdateAvailable: boolean
    readonly updateInfo: { version: string; releaseNotes?: unknown }
  } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export interface UpdateRelease {
  readonly version: string
  readonly notes: string | null
}

export interface UpdateController {
  readonly check: () => Promise<UpdateRelease | null>
  readonly download: (version: string) => Promise<void>
  /** 装上并退出：这是同步的一步 —— 安装器起没起来由 electron-updater 自己报错。 */
  readonly relaunch: () => void
}

const UPDATE_COMMANDS: readonly string[] = ['update_check', 'update_download', 'update_relaunch']

/**
 * 相位对齐靠版本号：这里记住「已经发现的那一版」，下载与安装都只认它。
 *
 * 宿主侧的暂存态是同一件事的另一端（electron-updater 自己按 updateInfo 对齐），
 * 所以这里不再开第二个「正在下载」的布尔量。
 */
export function createUpdateController(updater: UpdaterPort): UpdateController {
  let selected: string | null = null

  return {
    async check() {
      selected = null

      const found = await updater.checkForUpdates()

      /* 更新器停用与「已是最新」对界面是同一句话：没有可下载的东西。 */
      if (found === null || !found.isUpdateAvailable) {
        return null
      }

      const { version, releaseNotes } = found.updateInfo

      selected = version

      /* 发布说明的另一种形状是逐版本数组，界面不显示它，如实交回 null。 */
      return { version, notes: typeof releaseNotes === 'string' ? releaseNotes : null }
    },

    async download(version) {
      if (selected !== version) {
        throw new Error('选中的更新已经不在手上了')
      }

      await updater.downloadUpdate()
    },

    relaunch() {
      if (selected === null) {
        throw new Error('没有已下载的更新可安装')
      }

      selected = null
      /* 装完由 electron-updater 自己 app.quit()；退出屏障那边看 before-quit-for-update。 */
      updater.quitAndInstall()
    },
  }
}

export type UpdaterLoader = () => Promise<UpdaterPort>

export interface UpdateCommands {
  /** 认不认这条命令：主进程据此决定自己答还是转给原生。 */
  readonly handles: (command: unknown) => boolean
  readonly run: (command: string, args: unknown) => Promise<unknown>
}

export function createUpdateCommands(load: UpdaterLoader): UpdateCommands {
  let controller: UpdateController | null = null

  /* 只装一次：三条命令共用同一个相位，各自建一个控制器就是给相位开第二份真相。 */
  const controllerOf = async (): Promise<UpdateController> => {
    if (controller === null) {
      controller = createUpdateController(await load())
    }

    return controller
  }

  return {
    handles(command) {
      return typeof command === 'string' && UPDATE_COMMANDS.includes(command)
    },

    async run(command, args) {
      switch (command) {
        case 'update_check':
          return controllerOf().then((owned) => owned.check())

        case 'update_download': {
          const version =
            typeof args === 'object' && args !== null && !Array.isArray(args)
              ? (args as Record<string, unknown>)['version']
              : undefined

          if (typeof version !== 'string' || version.length === 0) {
            throw new Error('poietica: requestInvalid — 下载更新要说明是哪一个版本')
          }

          await (await controllerOf()).download(version)

          return null
        }

        case 'update_relaunch': {
          const owned = await controllerOf()

          owned.relaunch()

          return null
        }

        default:
          throw new Error(`poietica: requestInvalid — 不是更新命令：${command}`)
      }
    },
  }
}

/**
 * 真正的那一份：模块求值时不碰 electron-updater，调用时才装载。
 *
 * 动态 import 一个 CJS 包时，autoUpdater 这个 **getter 导出**不会出现在命名空间对象上
 * （它只在 default 上），解构拿到的是 undefined —— 报出来就是
 * 「Cannot read properties of undefined (reading 'checkForUpdates')」。所以两边都看一眼。
 */
export async function loadUpdater(): Promise<UpdaterPort> {
  return autoUpdaterOf(await import('electron-updater'))
}

/** 两种装载形状里挑出真有的那一个；都没有就早炸，别把 undefined 递到调用点上。 */
export function autoUpdaterOf(loaded: unknown): UpdaterPort {
  const shaped = loaded as { autoUpdater?: UpdaterPort; default?: { autoUpdater?: UpdaterPort } }
  const autoUpdater = shaped?.autoUpdater ?? shaped?.default?.autoUpdater

  if (autoUpdater === undefined) {
    throw new Error('poietica: internal — electron-updater 没有交出 autoUpdater')
  }

  return autoUpdater
}
