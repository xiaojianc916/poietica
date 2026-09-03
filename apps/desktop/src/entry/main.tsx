import '../styles/app.css'

import {
  type NativeCrashReport,
  readWorkbenchSession,
  takePreviousNativeCrashReport,
} from '@poietica/native-bridge'
import { reportFatalIncident } from '../notice/problem-presentation'
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
    /* 旧崩溃报告读不出来不能拦住一次健康启动；当前失败在原生日志里仍有记录。 */
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
