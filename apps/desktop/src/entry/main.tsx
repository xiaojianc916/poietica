import '../styles/app.css'

import {
  type NativeCrashReport,
  takePreviousNativeCrashReport,
} from '@poietica/native-bridge/diagnostics'
import { readWorkbenchSession } from '@poietica/native-bridge/workspace/session'
import { reportFatalIncident } from '../notice/fatal-incident'
import { installContextMenuGuard } from '../window/context-menu-guard'
import { installExternalLinks } from '../window/external-links'
import { installScrollbarSize } from '../window/scrollbar-size'
import { mountReactApplication } from './mount'

async function bootstrapApplication(): Promise<void> {
  installScrollbarSize()
  installExternalLinks()
  installContextMenuGuard()

  /* 工作台恢复是首帧的输入：先读回再挂载，否则会先画默认标签再跳到上次状态。 */
  const restored = await readWorkbenchSession()

  /* 挂载在 react-root 里同步提交，返回时首帧的 DOM 已在位，所以呈现就在下一句。 */
  const runtime = await mountReactApplication(getApplicationRoot(), restored)

  performance.mark('poietica:first-commit')

  void runtime.mainWindow.present().catch((cause: unknown) => {
    console.error('[Poietica] Failed to present the main window', cause)
  })

  requestAnimationFrame(() => {
    runtime.startBackgroundServices()
  })

  void reportPreviousNativeCrash()
}

async function reportPreviousNativeCrash(): Promise<void> {
  let report: NativeCrashReport | null

  try {
    report = await takePreviousNativeCrashReport()
  } catch (error: unknown) {
    /*
     * 宿主还没提供这条能力是**当前已知状态**（crash-report.ts 头注释），不是失败。
     * 它每次启动都会缺席 —— 记成 error 的结果是日志里每次开机多一条假错误，
     * 真正的失败被埋在它后面。读的时候真出错才记。
     */
    if (error instanceof Error && error.name === 'NativeCrashReportUnavailable') {
      return
    }

    console.error('[Poietica] Failed to inspect previous native crash report', error)

    return
  }

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

void bootstrapApplication()
