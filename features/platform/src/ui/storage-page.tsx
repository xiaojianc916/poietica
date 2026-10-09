import { Button, formatBytes, SettingRow, SettingsGroup, SettingsPage } from '@poietica/design-system'
import { useKernel } from '@poietica/ui-kernel'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import type { StorageEntry } from '../contract'
import type { PlatformApi } from './api'

/*
 * 存储页。**迁移自** legacy `storage-settings.tsx`：先看见、再清理；占用那张卡带
 * 「展开明细」的头按钮，清理那一组两个动作（安全的直接清、要重新登录的走二次确认）。
 *
 * 只改数据来源：legacy 的 StorageGateway 换成 platform 契约的 storageUsage /
 * storageClear；二次确认用内核的 dialogs.confirm（legacy 是 ConfirmationDialog）。
 */

/** 每一类的说法；认不出的 id 照原样显示，不猜。 */
const DESCRIPTIONS: Record<string, string> = {
  ledger: '对话索引、帧日志与附件索引。',
  settings: '主题、语言、快捷键与 agent 接入档案。',
  agents: 'agent 自己的配置、凭据、会话与技能。',
  attachments: '历史对话里的附件字节。',
  plugins: '装进来的插件副本。',
  workspace: '无项目会话的工作目录。',
  tools: '本应用自己装的工具与内置 Python 解释器。',
  logs: '排障用；日志按天保留。',
  'native-cache': '可以从上游重取的东西。',
  'kernel-cache': '网页与代码的磁盘缓存，随时可清，代价是下次加载慢一点。',
  'browser-data': '站点登录态与本地存储；清完要去那些站点重新登录。',
  'kernel-state': '内核自己的偏好与网络状态。',
  other: '数据根里没有归类的文件。',
}

const MEASURED_AT = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })

/** 存储页：占用卡（可展开明细）+ 清理组；要重新登录的那一项先走 dialogs.confirm */
export function StoragePage({ api }: { readonly api: PlatformApi }): ReactElement {
  const { dialogs } = useKernel().kernelServices
  const [entries, setEntries] = useState<readonly StorageEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [measuredAt, setMeasuredAt] = useState<Date | null>(null)
  const [failure, setFailure] = useState<{ where: 'read' | 'clear'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setEntries((await api.storageUsage()).entries)
      setMeasuredAt(new Date())
      setFailure(null)
    } catch (e) {
      setFailure({ where: 'read', text: `读不到存储占用：${reasonOf(e)}` })
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const clear = async (target: 'cache' | 'logs' | 'browser', confirmRequired: boolean): Promise<void> => {
    if (confirmRequired) {
      const ok = await dialogs.confirm({
        title: '清除内置浏览器数据？',
        body: '内置浏览器里所有站点的登录态与本地存储都会消失，且无法撤销。',
        confirmLabel: '清除',
        danger: true,
      })
      if (!ok) return
    }
    setBusy(true)
    setFailure(null)
    try {
      await api.storageClear(target)
      await refresh()
    } catch (e) {
      setFailure({ where: 'clear', text: `没有清干净：${reasonOf(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const occupied = (entries ?? []).filter((entry) => entry.bytes > 0)
  const total = occupied.reduce((sum, entry) => sum + entry.bytes, 0)

  return (
    <SettingsPage>
      <SettingsGroup
        headerAction={
          <Button
            aria-expanded={expanded}
            disabled={entries === null}
            onClick={() => {
              setExpanded(!expanded)
            }}
            size="xs"
            type="button"
            variant="soft"
          >
            {expanded ? '收起明细' : '展开明细'}
          </Button>
        }
        title="占用"
      >
        <SettingRow
          description={
            entries === null || measuredAt === null
              ? '正在测量…'
              : `共 ${formatBytes(total)} · 上次测量 ${MEASURED_AT.format(measuredAt)}`
          }
          label="数据根"
          warning={failure?.where === 'read' ? failure.text : undefined}
        >
          <Button disabled={busy} onClick={() => void refresh()} size="xs" type="button" variant="soft">
            {busy ? '测量中…' : '重新测量'}
          </Button>
        </SettingRow>

        {expanded
          ? occupied.map((entry) => (
              <SettingRow
                data-storage-entry={entry.id}
                description={DESCRIPTIONS[entry.id]}
                key={entry.id}
                label={entry.label}
              >
                <span className="settings-row__path" data-storage-bytes={entry.id}>
                  {formatBytes(entry.bytes)}
                </span>
              </SettingRow>
            ))
          : null}
      </SettingsGroup>

      <SettingsGroup title="清理">
        <SettingRow description="网页与代码的磁盘缓存。清完只是下次加载慢一点，登录态不动。" label="内核缓存">
          <Button disabled={busy} onClick={() => void clear('cache', false)} size="xs" type="button" variant="soft">
            {busy ? '清理中…' : '清除缓存'}
          </Button>
        </SettingRow>

        <SettingRow description="内置浏览器里所有站点的登录态与本地存储，清完要重新登录。" label="内置浏览器数据">
          <Button
            disabled={busy}
            onClick={() => void clear('browser', true)}
            size="xs"
            type="button"
            variant="dangerSoft"
          >
            删除数据
          </Button>
        </SettingRow>

        <SettingRow description="排障用；日志按天保留。" label="日志与暂存">
          <Button disabled={busy} onClick={() => void clear('logs', false)} size="xs" type="button" variant="soft">
            清理日志
          </Button>
        </SettingRow>

        {failure?.where === 'clear' ? <SettingRow description={failure.text} label="上一步没有完成" /> : null}
      </SettingsGroup>

      <SettingsGroup title="位置">
        <SettingRow description="打开应用的数据根目录" label="数据文件夹">
          <Button disabled={busy} onClick={() => void api.openDataFolder()} size="xs" type="button" variant="soft">
            打开
          </Button>
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  )
}

/** 跨边界来的失败已经是折过的错误，它的 message 就是那句话。 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : '未知原因'
}
