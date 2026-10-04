/*
 * 主进程的日志出口与闸门：electron-log（Electron 这一档的事实标准）。
 *
 * 落盘、轮转、崩溃钩子、渲染层 console 收集全归 electron-log；这个文件只做三件它不做、
 * 而我们必须做的事：
 *
 * 1. **每行一个 JSON 对象**。成形规则在 ./log-line.ts —— 原生侧那份
 *    （apps/desktop/native/src/log_file.rs）也是 JSON Lines，同一个目录里两种格式，
 *    读的人得先弄清自己在读哪一份，所以两边逐字段对齐。
 * 2. **渲染层那条路要脱敏**。经 console-message 回来的正文直接来自渲染层，可能带
 *    Bearer / URL 凭据 / 用户目录。密钥不落我们的盘是产品不变量，该判断在 log-line.ts
 *    里，与原生侧同一批判据。
 * 3. **不弹系统错误框**。electron-log 的 errorHandler 默认对未捕获异常
 *    `dialog.showErrorBox`；这个应用有自己的致命屏（packages/problem 的
 *    failureCoordinator + pre-react-entry 的终端屏），再弹一个原生框是第二套错误面。
 *
 * 分工上有一条硬边界：**electron-log 管「什么时候写、写多少、写到哪」，我们只管
 * 「写出来的一行长什么样」与「闸门开在哪个级别」**。手写落盘（旧 logging.ts 的
 * 缓存/去重/上限与 log_file.rs 那一整套）已经删掉，不再回来。
 *
 * 顺序即不变量：`installLogging` 必须在**建窗之前**调 —— 它之后发生的每一次
 * console 异常与进程级崩溃才留在盘上。
 */
import { join } from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'

import { jsonLine } from './log-line'

/** 单份上限。electron-log 自己轮转：达到上限就把现役改成 .old，新开一份。 */
const MAX_FILE_BYTES = 4 * 1024 * 1024

/** 档位与原生侧的同名（apps/desktop/native/src/settings/model.rs 的 LogLevel）。 */
export type LogLevelName = 'error' | 'warn' | 'info' | 'debug'

/** 设置还没读出来时的那一档，也是出厂值。 */
const DEFAULT_LOG_LEVEL: LogLevelName = 'warn'

const LOG_LEVELS: readonly LogLevelName[] = ['error', 'warn', 'info', 'debug']

/**
 * 装上出口。`app.whenReady` 之后、建窗之前调。
 *
 * `level` 是设置里那一刻的闸门；读不出来就按默认。之后改设置走 `setLogLevel`。
 *
 * 文件名保持 electron-log 的默认（`main.log`）：这个库已经按 processType 分好文件，
 * 抹掉它等于把它的判断重写一遍。原生侧那份叫 `poietica.log`，不会撞。
 */
export function installLogging(level: unknown): void {
  /*
   * 目录来自 `app.getPath('logs')`（main.ts 用 `setAppLogsPath` 钉进数据根），
   * 同一个目录在 start 时交给原生侧，于是「日志在哪」只有一个答案。
   */
  log.transports.file.resolvePathFn = () => join(app.getPath('logs'), 'main.log')
  log.transports.file.maxSize = MAX_FILE_BYTES
  log.transports.file.format = ({ data, level: recordLevel, message }) => [
    jsonLine({ data, level: recordLevel, date: message.date ?? new Date() }),
  ]

  applyLevel(level)

  /*
   * 渲染层收集：spyRendererConsole 让渲染进程的 console 经 webContents 的
   * console-message 事件回到这里，与主进程走同一条出口。不用 initialize({ preload })：
   * 那个会往每个 session 注入一个 preload 脚本，而我们的 preload 契约是显式的
   * （apps/desktop/electron/preload.ts），不该出现第二份隐式注入。
   */
  log.initialize({ preload: false, spyRendererConsole: true })

  /* 进程级崩溃：electron-log 自己挂 uncaughtException / unhandledRejection。 */
  log.errorHandler.startCatching({ showDialog: false })

  /* Electron 官方事件（子进程消失、页面装载失败、preload 报错…）一并进日志。 */
  log.eventLogger.startLogging()
}

/**
 * 换闸门。设置里那一格改了就走这里 —— 与原生侧的 `log_file::set_level` 同一个动作。
 *
 * 收不可信输入：这个值从设置文档里来，而设置文档用户可以手改。
 */
export function setLogLevel(level: unknown): void {
  applyLevel(level)
}

function applyLevel(level: unknown): void {
  const resolved = LOG_LEVELS.includes(level as LogLevelName)
    ? (level as LogLevelName)
    : DEFAULT_LOG_LEVEL

  log.transports.file.level = resolved
  log.transports.console.level = resolved
}
