import { Button, formatBytes, SettingRow, SettingsGroup, SettingsPage } from '@poietica/design-system'
import { useKernel } from '@poietica/ui-kernel'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import type { StorageUsage } from '../contract'
import type { PlatformApi } from './api'
import { StorageBar } from './storage-usage'

/* 先看见、再清理；占用那张卡里是一条用量条加一排图例，每一格的读数在图例里。
 * 数据来自 platform 契约的 storageUsage / storageClear：Host 把上次测量连时刻一起缓存在数据根里，
 * 进页面直接就画上一份结果，不再每次白屏等一遍目录扫描；只有「重新测量」才真的重扫。
 * 契约里的 id 在界面上按「谁的数据」合成几格（数据库、omp 的其余数据都是「Agent 数据」）：类多了没人看得懂。
 * 每一格都有主人和上限：聊天里的图片随对话由 Core 回收，浏览器缓存有预算（runtime-layout 的 storage-budget），
 * 日志按大小轮换；这里的文案照实写这些规则，不许诺做不到的（比如「按天保留」）。 */
/*
 * 上一次拿到的结果留在模块里：设置页每切走一次就卸载一次，Host 的缓存虽然还在，
 * 但这一趟 RPC 仍要往返、首次还要等扫描。组件重挂时先用这一份画出来，页面不再回到「正在测量…」。
 * 只有模块被整个替换（应用重启）时才从空开始。
 */
let lastUsage: StorageUsage | null = null

export function StoragePage({ api }: { readonly api: PlatformApi }): ReactElement {
  const { dialogs } = useKernel().kernelServices
  const [usage, setUsage] = useState<StorageUsage | null>(lastUsage)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ where: 'read' | 'clear'; text: string } | null>(null)

  /* 组件卸载后不再回写状态：测量可能跑好几秒，那时页面早换走了。 */
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true

    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(
    async (refresh: boolean) => {
      if (refresh) setBusy(true)
      setFailure(null)
      try {
        const found = await api.storageUsage(refresh)
        lastUsage = found
        if (alive.current) setUsage(found)
      } catch (e) {
        if (alive.current) setFailure({ where: 'read', text: `读不到存储占用：${reasonOf(e)}` })
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [api],
  )

  useEffect(() => {
    void load(false)
  }, [load])

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
      // 清完必须重扫：缓存里的数字已经不对了。
      await load(true)
    } catch (e) {
      setFailure({ where: 'clear', text: `没有清干净：${reasonOf(e)}` })
      if (alive.current) setBusy(false)
    }
  }

  const entries = usage?.entries ?? []
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)

  return (
    <SettingsPage>
      <SettingsGroup title="占用">
        {/* 不写「数据根」这个名字：这张卡本身就是数据根的占用，标题已在上方。第一行只报总量。 */}
        <SettingRow
          label={usage === null ? '正在测量…' : `共 ${formatBytes(total)}`}
          warning={failure?.where === 'read' ? failure.text : undefined}
        >
          <Button
            disabled={busy}
            onClick={() => {
              void load(true)
            }}
            size="xs"
            type="button"
            variant="soft"
          >
            {busy ? '测量中…' : '重新测量'}
          </Button>
        </SettingRow>

        {/* 加载前后画的是同一副骨架：空条 + 「正在测量…」占的高度与条 + 图例完全一致。 */}
        <div className="settings-usage__panel">
          <StorageBar usage={usage} />
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
