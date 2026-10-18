import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppContract } from '@poietica/contract-kit'
import {
  AppError,
  createServiceRegistry,
  DisposableStore,
  type Logger,
  SystemErrorCode,
  sortModules,
} from '@poietica/foundation'
import { consoleSink, createLogger, jsonlFileSink } from '@poietica/logging'
import { Router } from '@poietica/rpc'
import { app, dialog, net, protocol, type WebContents } from 'electron'
import { type AppIdentity, configureAppIdentity } from './app-identity'
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, createAppProtocolHandler } from './app-protocol'
import { ASSET_SCHEME, createAssetDispatcher } from './asset-protocol'
import { createCoreOutputSink } from './core-output'
import { CoreSupervisor } from './core-supervisor'
import { createIpcTransport } from './ipc-transport'
import { HostLoggingToken, type HostModule, type HostModuleContext } from './module'
import { createQuitCoordinator } from './quit'
import { createHostRpcBinding } from './rpc-binding'
import { RpcHub } from './rpc-hub'
import { WindowRegistry } from './windows'

export interface HostKernelOptions {
  readonly modules: readonly HostModule[]
  readonly appContract: AppContract
  readonly protocolVersion: number
  readonly appVersion: string
  /** 以下路径由 apps/desktop/src/main/index.ts 计算（开发与安装两种情况） */
  readonly paths: {
    /** out/preload/index.cjs */
    readonly preload: string
    /** out/renderer/index.html */
    readonly rendererFile: string
    /** process.env.ELECTRON_RENDERER_URL（electron-vite dev 时存在） */
    readonly rendererDevUrl: string | undefined
    /** 安装后：<resources>/core/poietica-core.exe；开发：apps/core/dist/poietica-core.exe */
    readonly coreExe: string
    readonly resourcesDir: string
  }
}

export function runHostKernel(opts: HostKernelOptions): void {
  // ① 身份与数据根（ready 之前）
  const identity = configureAppIdentity()
  // ② 单实例
  if (!app.requestSingleInstanceLock()) {
    // 走到这里有两种情况，凭现象分不出来：a) 真的已经有一个实例在跑；b) 拿不到实例锁 —— Chromium 的
    // SingletonLock 建不出来（userData 权限、终端是管理员身份等），上游同样报 "Lock file can not be created"
    // 并返回 false。此时日志目录还没建（第 ③ 步在后面），什么都不写就退出，现象就是「窗口一闪、没有任何日志」。
    // 这条 stderr 就是为 #21 那次排查补的：让人一眼看出是锁的问题而不是崩溃。
    const existing = app.hasSingleInstanceLock()
    process.stderr.write(
      existing
        ? 'poietica: 已有实例在运行，本次启动退出（第二实例聚焦已有窗口）。\n'
        : `poietica: 无法取得单实例锁，应用将退出。\n` +
            `  数据根：${identity.layout.root}\n` +
            '  常见原因：终端以管理员身份运行、或该目录的权限不允许创建锁文件。\n' +
            '  换一个数据根可绕过：bun run dev -- --poietica-data-root=<另一个绝对路径>\n',
    )
    app.quit()
    return
  }
  // ③ 目录与日志
  mkdirSync(identity.layout.logsDir, { recursive: true })
  let level: 'debug' | 'info' | 'warn' | 'error' = identity.isPackaged ? 'info' : 'debug'
  const mainLog = jsonlFileSink({ file: identity.layout.mainLog, maxBytes: 5 * 1024 * 1024, keep: 3 })
  // 按批落盘（见 jsonl-file-sink.ts）：退出时把攒着的写完；error 级记录本来就当场落盘
  process.on('exit', () => mainLog.close())
  const logger = createLogger({
    level: () => level,
    sinks: identity.isPackaged ? [mainLog] : [mainLog, consoleSink()],
    base: { proc: 'host' },
  })
  process.on('uncaughtException', (e) => logger.error('uncaughtException', { error: String(e), stack: e.stack }))
  process.on('unhandledRejection', (e) => logger.error('unhandledRejection', { error: String(e) }))
  // ④ 自定义协议特权声明（ready 之前，只能调用一次）
  protocol.registerSchemesAsPrivileged([
    { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    /* 应用外壳：安装版从这里加载渲染进程，才有 V8 代码缓存（P-06，见 app-protocol.ts）。 */
    { scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES },
  ])
  void app
    .whenReady()
    .then(() =>
      boot(opts, identity, logger, {
        get: () => level,
        set: (l) => {
          level = l
        },
      }),
    )
    .catch((e: unknown) => fatal(logger, identity.layout.mainLog, 'kernel', e))
}

async function boot(
  opts: HostKernelOptions,
  identity: AppIdentity,
  logger: Logger,
  levelRef: { get(): 'debug' | 'info' | 'warn' | 'error'; set(l: 'debug' | 'info' | 'warn' | 'error'): void },
): Promise<void> {
  const log = logger.child({ scope: 'kernel' })
  const strict = !identity.isPackaged
  const hostRouter = new Router()
  const registry = createServiceRegistry()
  registry.kernelScope().provide(HostLoggingToken, { level: levelRef.get, setLevel: levelRef.set })
  const windows = new WindowRegistry({ logger: logger.child({ scope: 'window' }), isPackaged: identity.isPackaged })
  const assets = createAssetDispatcher(logger.child({ scope: 'asset' }))

  // ⑤ 总机与 Core 看护人（此时两者都还没有连接）
  let hub!: RpcHub
  const supervisor = new CoreSupervisor({
    layout: identity.layout,
    coreExe: opts.paths.coreExe,
    homeDir: os.homedir(),
    strict,
    logLevel: levelRef.get,
    baseEnv: () => ({ ...process.env }),
    protocolVersion: opts.protocolVersion,
    logger: logger.child({ scope: 'supervisor' }),
    coreOutput: createCoreOutputSink(logger),
    onRequest: (method, params, ctx) => hub.handleFromCore(method, params, ctx),
    onNotification: (method, params) => hub.fromCore(method, params),
  })
  hub = new RpcHub({
    appContract: opts.appContract,
    hostRouter,
    supervisor,
    logger: logger.child({ scope: 'hub' }),
    createTransport: (wc) => createIpcTransport(wc as WebContents),
  })
  supervisor.onStatus((status) => hub.broadcast('core.status', status))
  // 系统契约中 owner='host' 的方法由内核自己实现
  const system = opts.appContract.contracts.find((c) => c.id === 'system')!
  for (const def of system.methods) {
    if (def.name === 'core.restart') {
      hostRouter.register(def, async () => {
        await supervisor.restart()
        return {}
      })
    }
    if (def.name === 'core.getStatus') hostRouter.register(def, () => supervisor.status)
  }

  const quit = createQuitCoordinator({ logger: logger.child({ scope: 'quit' }), supervisor, windows })

  // ⑥ 模块 setup（拓扑序）
  const beforeWindow: Array<() => void | Promise<void>> = []
  const onReady: Array<() => void | Promise<void>> = []
  for (const m of sortModules(opts.modules)) {
    const disposables = new DisposableStore()
    quit.addDisposables(disposables)
    const ctx: HostModuleContext = {
      moduleId: m.id,
      logger: logger.child({ module: m.id }),
      layout: identity.layout,
      isPackaged: identity.isPackaged,
      appVersion: opts.appVersion,
      resourcesDir: opts.paths.resourcesDir,
      rpc: createHostRpcBinding(m.contract, {
        moduleId: m.id,
        router: hostRouter,
        broadcast: (n, p) => hub.broadcast(n, p),
        strict,
      }),
      core: hub.coreCaller(),
      windows,
      assets: { register: (host, handler) => assets.register(m.id, host, handler) },
      services: registry.scoped(m.id, m.dependsOn ?? []),
      app: { quit: (qo) => quit.quit(`module:${m.id}`, qo), quitting: () => quit.quitting },
      lifecycle: {
        beforeWindow: (fn) => {
          beforeWindow.push(fn)
        },
        onReady: (fn) => {
          onReady.push(fn)
        },
        onShutdown: (fn) => {
          quit.addShutdownHook(m.id, fn)
        },
      },
      disposables,
    }
    try {
      await m.setup(ctx)
    } catch (e) {
      fatal(logger, identity.layout.mainLog, m.id, e)
      return
    }
  }
  // ⑦ 每个 owner='host' 的方法都必须有实现
  const missing = [...opts.appContract.methods.values()]
    .filter((d) => d.owner === 'host' && !hostRouter.has(d.name))
    .map((d) => d.name)
  if (missing.length > 0) {
    fatal(
      logger,
      identity.layout.mainLog,
      'kernel',
      new AppError(SystemErrorCode.unhandledMethod, `未实现的 Host 方法：${missing.join(', ')}`),
    )
    return
  }

  // ⑧ beforeWindow → 协议 → 窗口
  for (const fn of beforeWindow) await fn()
  protocol.handle(ASSET_SCHEME, (request) => assets.dispatch(request))
  protocol.handle(
    APP_SCHEME,
    createAppProtocolHandler(path.dirname(opts.paths.rendererFile), (file) => net.fetch(pathToFileURL(file).href)),
  )
  const win = windows.createMain({
    preload: opts.paths.preload,
    rendererDevUrl: opts.paths.rendererDevUrl,
  })
  hub.attachWindow(win.webContents)
  win.on('session-end', () => supervisor.killNow()) // Windows 注销 / 关机：来不及优雅退出，直接杀 Core
  // ⑨ onReady → 启动 Core（不等待）
  for (const fn of onReady) {
    try {
      await fn()
    } catch (e) {
      log.error('onReady hook failed', { error: String(e) })
    }
  }
  void supervisor.start()
  // ⑩ 应用级事件
  app.on('second-instance', () => windows.focusMain())
  app.on('before-quit', (event) => {
    if (!quit.quitting) {
      event.preventDefault()
      void quit.quit('before-quit')
    }
  })
  app.on('window-all-closed', () => {
    void quit.quit('window-all-closed')
  })
  log.info('host ready', { version: opts.appVersion, dataRoot: identity.layout.root })
}

function fatal(logger: Logger, logFile: string, where: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  logger.error('fatal startup error', { where, error: message })
  dialog.showErrorBox('Poietica 无法启动', `${where}：${message}\n\n日志：${logFile}`)
  app.exit(1)
}
