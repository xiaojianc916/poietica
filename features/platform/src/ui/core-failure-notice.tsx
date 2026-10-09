import { Button } from '@poietica/design-system'
import { useCoreStatus } from '@poietica/ui-kernel'
import type { ReactElement } from 'react'

/** Core 失败文案（07 页 §1E 的表，原样照抄） */
export const FAILURE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  crash_loop: 'Agent 引擎反复崩溃，已停止自动重启',
  isolation_violated: '隔离检查失败：Agent 数据目录可能被外部配置改写',
  protocol_mismatch: '安装文件不一致，请重新安装',
  core_missing: '找不到 Agent 引擎程序，请重新安装',
  bad_arguments: 'Agent 引擎启动参数错误',
  start_timeout: 'Agent 引擎启动超时',
})

/*
 * 「Agent 引擎起不来」这一条，画在**入口界面的吉祥物上方**。
 *
 * 产品负责人 2026-10-06：需要人重新启动的那一格，改成与「还没有配置任何模型服务商」
 * 一模一样的 UI、一模一样的位置（`builtinPoints.entryNotices`，见 conversation 的
 * EntryNotices）。此前它是外壳栅格里的**横幅行**（platform.coreBanner 的 failed 分支），
 * 一条横贯整窗的告警条；现在只剩内容与两个动作，容器交给入口提示那一列。
 *
 * 与模型提示同形同序：一句说明 + 一颗按钮。两颗动作（重新启动 / 打开日志文件夹）
 * 与 07 页 §1E 的表一致，文案一字未改。
 *
 * 文案表住在这一份里（原先在 core-banner.tsx）：那条「正在启动 Agent 引擎…」横幅已按
 * 产品负责人 2026-10-06 的要求**整条删除**，失败文案是这条入口提示的唯一产地。
 */

/** 「这件事要人动手」的那一档：failed。其余状态都不占入口提示这一格。 */
export function coreFailureVisible(status: { readonly state: string }): boolean {
  return status.state === 'failed'
}

export function CoreFailureNotice({
  onOpenLogs,
  onRestart,
}: {
  readonly onOpenLogs: () => void
  readonly onRestart: () => void
}): ReactElement | null {
  const status = useCoreStatus()
  if (status.state !== 'failed') return null

  const text = status.reason === null ? 'Agent 引擎不可用' : (FAILURE_TEXT[status.reason] ?? 'Agent 引擎不可用')

  return (
    <span className="core-failure-notice">
      <span className="core-failure-notice__text">{text}</span>
      <Button onClick={onRestart} size="xs" variant="soft">
        重新启动
      </Button>
      <Button onClick={onOpenLogs} size="xs" variant="ghost">
        打开日志文件夹
      </Button>
    </span>
  )
}
