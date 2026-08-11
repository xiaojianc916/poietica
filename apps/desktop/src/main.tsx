import './app.css'

import {
  type MainWindowController,
  type NativeCrashReport,
  takePreviousNativeCrashReport,
} from '@poietica/desktop-adapters'
import { readWorkbenchSession } from '@poietica/ipc'
import { DEFAULT_APP_SETTINGS } from '@poietica/settings'
import { applyThemePreference } from '@poietica/ui'
import { mountReactApplication } from './bootstrap/react-root'
import { installContextMenuGuard } from './chrome/context-menu-guard'
import { installExternalLinks } from './chrome/external-links'
import { installScrollbarSize } from './chrome/scrollbar-size'
import { installTableDownloads } from './chrome/table-downloads'
import { reportFatalIncident } from './failures/terminal-policy'

async function bootstrapApplication(): Promise<void> {
  installScrollbarSize()
  installExternalLinks()
  installTableDownloads()
  installContextMenuGuard()

  /*
   * 主题必须在第一帧之前落到文档上。
   *
   * 深色令牌挂在 :root[data-theme="dark"]，浅色挂在裸 :root（tokens/light.css）
   * —— 属性缺席时整套令牌无条件解成浅色，而 index.html 那份预 React 副本跟着
   * prefers-color-scheme 走，于是深色桌面的冷启动是「深 → 整屏白 → 深」两跳。
   *
   * 默认值一直写着 system，此前只是没有人在设置回来之前应用它，那段窗口里既
   * 不是存下的选择也不是默认值。这里不引入第二份状态：设置读回来之后
   * app-shell 再校一次，重复调用由 theme-controller 自己摘掉上一个 matchMedia
   * 监听。
   */
  applyThemePreference(DEFAULT_APP_SETTINGS.theme)

  /*
   * 工作台恢复是首帧的输入，必须在 React 挂载前读回；否则会先画默认标签，
   * 再切换到上次状态。原生侧已经在窗口出现前完成数据库迁移，这里只等待
   * 一条 SELECT。
   *
   * 上一次崩溃的报告仍不阻塞挂载：React 就绪后再读取，读到了交给已经在跑
   * 的致命管线（reportFatalIncident → FatalErrorHost）。
   */
  const restored = await readWorkbenchSession()
  const mounted = mountReactApplication(getApplicationRoot(), restored)

  presentWhenPainted(mounted.runtime.mainWindow)

  void reportPreviousNativeCrash()
}

/*
 * 窗口以 visible: false 创建，几何已在原生 setup 中恢复，呈现的时机在这里。
 *
 * 两帧：第一帧提交 DOM，第二帧之前浏览器完成绘制。此前 show() 在 Rust 的 setup
 * 里调用，那早于 webview 执行任何脚本，用户先看到的是一个空的背景色窗口。
 *
 * 若这里因为任何原因没能执行，原生侧的看门狗会在 8 秒后兜底呈现，不会留下一个
 * 永远不可见的进程。
 */
const PRESENT_DEADLINE_MS = 100

function presentWhenPainted(mainWindow: MainWindowController): void {
  let presented = false

  const present = (): void => {
    if (presented) {
      return
    }

    presented = true

    void mainWindow.present().catch((cause: unknown) => {
      console.error('[Poietica] Failed to present the main window', cause)
    })
  }

  /*
   * 两帧是理想路径：第一帧提交 DOM，第二帧之前浏览器完成绘制。
   *
   * 但窗口是 visible: false 创建的，而 requestAnimationFrame 在文档不可见时
   * 会被节流、甚至完全不触发 —— 那是规范行为，不是缺陷。只挂在 rAF 上，
   * 这条正常路径就没有保证，冷启动会落到原生侧那个 8 秒看门狗上，用户看到
   * 的是八秒的空窗。
   *
   * 所以两个信号赛跑，谁先到谁呈现：绘制完成，或者这个期限到了。
   */
  requestAnimationFrame(() => {
    requestAnimationFrame(present)
  })

  setTimeout(present, PRESENT_DEADLINE_MS)
}

async function readPreviousNativeCrashReport(): Promise<NativeCrashReport | null> {
  try {
    return await takePreviousNativeCrashReport()
  } catch (error: unknown) {
    // Failure to inspect an old crash report must not prevent a healthy
    // application startup. The current failure remains visible in native logs.
    console.error('[Poietica] Failed to inspect previous native crash report', error)

    return null
  }
}

async function reportPreviousNativeCrash(): Promise<void> {
  const report = await readPreviousNativeCrashReport()

  if (report === null) {
    return
  }

  const error = new Error(report.message)

  error.name = 'NativeProcessCrash'
  error.stack = [report.message, '', 'Native backtrace:', report.backtrace].join('\n')

  reportFatalIncident({
    impact: 'native-fatal',
    error,
    kind: 'native-crash',
    phase: 'preflight',
    code: 'FATAL_PREVIOUS_NATIVE_PROCESS_CRASH',
    title: '应用上次运行时异常终止',
    ...(report.location === null
      ? {}
      : {
          source: report.location,
        }),
    recovery: 'reload',
    context: {
      nativeIncidentId: report.incidentId,
      nativeOccurredAt: report.occurredAt,
      nativeProcess: report.process,
      nativeThread: report.thread,
      appVersion: report.appVersion,
      targetOs: report.targetOs,
      targetArch: report.targetArch,
    },
  })
}

function getApplicationRoot(): HTMLElement {
  const root = document.getElementById('root')

  if (!root) {
    throw new Error('Application root element "#root" was not found.')
  }

  return root
}

/*
 * 引导调用留在模块末尾，不要往上挪。
 *
 * 函数声明在求值任何语句之前就完成初始化，const 不会 —— 它直到自己那条语句被
 * 求值之前一直处在暂时性死区，读它抛 ReferenceError。调用一旦放到声明之上，
 * presentWhenPainted 就会在 PRESENT_DEADLINE_MS 初始化之前读它；而这条类型检查
 * 与 lint 都看不见：从函数体里引用后面声明的模块级 const 在编译期完全合法，要
 * 判定它是否过早得做调用图可达性分析。
 *
 * 挪到末尾不花时间：整个模块体是同一次同步求值，调用在第几行都在同一个任务里
 * 跑完，早于任何一次绘制。
 */
void bootstrapApplication()
