import { Button } from '@poietica/design-system'
import { type Observable, useObservable } from '@poietica/ui-kernel'
import type { ReactElement } from 'react'
import type { CoreDiagnostics } from '../contract'

export type ReadOnlyReason = Extract<CoreDiagnostics['dataMode'], { mode: 'readOnly' }>['reason']

/** ADR-004：数据库以只读打开的两种来路，各一句给人看的话 */
export const READ_ONLY_TEXT: Readonly<Record<ReadOnlyReason, string>> = Object.freeze({
  data_too_new: '数据来自更新的 Poietica，当前只读；安装新版本后才能修改',
  migration_failed: '数据库升级失败，已恢复到升级前的数据并以只读打开',
})

/** diagnostics.core 的 dataMode → 这条提示要说的那一格；可写就是 null（不占位） */
export function readOnlyReason(mode: CoreDiagnostics['dataMode']): ReadOnlyReason | null {
  return mode.mode === 'readOnly' ? mode.reason : null
}

/* 与「Core 起不来」同形同位（入口提示那一列）：只有一句话和一个「打开日志文件夹」 */
export function DataReadOnlyNotice({
  mode,
  onOpenLogs,
}: {
  readonly mode: Observable<ReadOnlyReason | null>
  readonly onOpenLogs: () => void
}): ReactElement | null {
  const reason = useObservable(mode)
  if (reason === null) return null
  return (
    <span className="core-failure-notice">
      <span className="core-failure-notice__text">{READ_ONLY_TEXT[reason]}</span>
      <Button onClick={onOpenLogs} size="xs" variant="ghost">
        打开日志文件夹
      </Button>
    </span>
  )
}
