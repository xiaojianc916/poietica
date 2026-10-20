import { Button, formatBytes, SettingRow, SettingsGroup, SettingsPage } from '@poietica/design-system'
import { useKernel } from '@poietica/ui-kernel'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import type { StorageEntry } from '../contract'
import type { PlatformApi } from './api'
import { StorageBar } from './storage-usage'

/* 先看见、再清理；占用那张卡里是一条用量条加一排图例，清理那一组两个动作（安全的直接清、要重新登录的走二次确认）。
 * 只改数据来源：legacy 的 StorageGateway 换成 platform 契约的 storageUsage / storageClear；二次确认用内核的 dialogs.confirm。
 * 契约里的 id 在界面上按「谁的数据」合成几格（数据库、omp 的其余数据都是「Agent 数据」）：类多了没人看得懂。
 * 每一格都有主人和上限：聊天里的图片随对话由 Core 回收，浏览器缓存有预算（runtime-layout 的 storage-budget），
 * 日志按大小轮换；这里的文案照实写这些规则，不许诺做不到的（比如「按天保留」）。 */
const MEASURED_AT = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })

export function StoragePage({ api }: { readonly api: PlatformApi }): ReactElement {
  const { dialogs } = useKernel().kernelServices
  const [entries, setEntries] = useState<readonly StorageEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
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

  const occupied = entries ?? []
  const total = occupied.reduce((sum, entry) => sum + entry.bytes, 0)

  return (
    <SettingsPage>
      <SettingsGroup title="占用">
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

        <div className="settings-usage__panel">
          {entries === null ? (
            <p className="settings-usage__empty">正在测量…</p>
          ) : (
            <StorageBar entries={occupied} total={total} />
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title="清理">
        <SettingRow
          description="网页与脚本的磁盘缓存，有上限、满了自动淘汰旧的。清完只是下次加载慢一点，登录态不动。"
          label="浏览器缓存"
        >
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

        <SettingRow description="排障用；每个日志满 5 MB 就轮换，另外只留 3 份旧的。清理只删旧的那几份。" label="日志">
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

function reasonOf(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : '未知原因'
}
