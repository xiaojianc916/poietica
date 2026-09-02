import '../styles/app.css'

import { applyThemePreference } from '@poietica/design-system'
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
  applyThemePreference('system')

  /* 工作台恢复是首帧的输入：先读回再挂载，否则会先画默认标签再跳到上次状态。 */
  const restored = await readWorkbenchSession()

  /* 挂载在 react-root 里同步提交，返回时首帧的 DOM 已在位，所以呈现就在下一句。 */
  const runtime = mountReactApplication(getApplicationRoot(), restored)

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
