import { Button, ConfirmationDialog, formatBytes } from '@poietica/design-system'
import { useCallback, useEffect, useState } from 'react'
import type { StorageGateway, StorageReport } from '../storage/port'
import { SettingRow, SettingsGroup, SettingsPage } from './settings-primitives'

/*
 * 存储那一页：先看见，再清理。
 *
 * 占用由主进程数出来（apps/desktop/electron/storage.ts），这里只画；两个清理动作各是一
 * 条宿主命令，交回的也是同一份测量，所以清完不必自己再问一遍。
 *
 * 这一页不每次重数：进页面那一次读的是缓存里那份，只有头一次、过期（两小时）或者人点了
 * 「重新测量」才真的走一趟。所以「上次测量」是必写的一格 —— 显示旧数字而不说是旧的，
 * 比慢一点更糟。分类明细默认收起：这一页最常见的两件事是「看一眼占了多少」与「清一下」，
 * 十几行数字不该挡在前面。
 *
 * 清理只开两个口：内核缓存（清了只是下次慢一点）与内置浏览器的站点数据（清了要重新
 * 登录，所以走二次确认）。账本、附件、agent 配置只有占用、没有入口 —— 不能清的东西
 * 就让它可见。
 */

const MEASURED_AT = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })

/** 每一类的说法；id 是宿主那张表的键。认不出的 id 照原样显示，不猜。 */
const LABELS: Record<string, { readonly label: string; readonly description: string }> = {
  ledger: { label: '对话账本', description: '对话索引、帧日志与附件索引。' },
  settings: { label: '设置', description: '主题、语言、快捷键与 agent 接入档案。' },
  agents: { label: 'agent 数据', description: 'agent 自己的配置、凭据、会话与技能。' },
  attachments: { label: '附件', description: '历史对话里的附件字节。' },
  plugins: { label: '插件', description: '装进来的插件副本。' },
  workspace: { label: '无项目工作目录', description: '无项目会话的工作目录。' },
  tools: { label: '受管工具', description: '本应用自己装的工具与内置 Python 解释器。' },
  logs: { label: '日志与暂存', description: '排障用；日志按天保留。' },
  'native-cache': { label: '原生缓存', description: '可以从上游重取的东西。' },
  'kernel-cache': {
    label: '内核缓存',
    description: '网页与代码的磁盘缓存，随时可清，代价是下次加载慢一点。',
  },
  'browser-data': {
    label: '内置浏览器数据',
    description: '站点登录态与本地存储；清完要去那些站点重新登录。',
  },
  'kernel-state': { label: '内核其余状态', description: '内核自己的偏好与网络状态。' },
  other: { label: '其他', description: '数据根里没有归类的文件。' },
}

const READ_FAILED = '读不到存储占用：'
const CLEAR_CACHE_FAILED = '缓存没有清干净：'
const CLEAR_DATA_FAILED = '站点数据没有清干净：'

export interface StorageSettingsProps {
  /* 由组合根注入且**引用稳定**：这一页的读以它为依赖，每次渲染换一个新对象会反复重读。 */
  readonly gateway: StorageGateway
}

/** 失败落在哪一格：读占用失败归占用，清理失败归清理 —— 报在别处等于没报。 */
type Failure = { readonly where: 'read' | 'clear'; readonly text: string }

export function StorageSettings({ gateway }: StorageSettingsProps) {
  const [report, setReport] = useState<StorageReport | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState(false)

  /* 顺手的一次读：新鲜的那一份直接回来，所以来回切页面不会反复数。 */
  const read = useCallback(async () => {
    try {
      setReport(await gateway.report())
      setFailure(null)
    } catch (cause) {
      setFailure({ where: 'read', text: READ_FAILED + reasonOf(cause) })
    }
  }, [gateway])

  useEffect(() => {
    void read()
  }, [read])

  const measure = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)

    try {
      setReport(await gateway.measure())
      setFailure(null)
    } catch (cause) {
      setFailure({ where: 'read', text: READ_FAILED + reasonOf(cause) })
    } finally {
      setBusy(false)
    }
  }

  const clear = async (kind: 'cache' | 'browser'): Promise<void> => {
    setBusy(true)
    setFailure(null)
    setConfirming(false)

    try {
      /* 交回的就是清完那一次测量，省掉一次往返，也不会画出一个中间态。 */
      setReport(
        kind === 'cache' ? await gateway.clearKernelCache() : await gateway.clearBrowserData(),
      )
    } catch (cause) {
      setFailure({
        where: 'clear',
        text: (kind === 'cache' ? CLEAR_CACHE_FAILED : CLEAR_DATA_FAILED) + reasonOf(cause),
      })
    } finally {
      setBusy(false)
    }
  }

  const occupied = report?.entries.filter((entry) => entry.bytes > 0) ?? []

  return (
    <SettingsPage>
      <SettingsGroup
        headerAction={
          <Button
            aria-expanded={expanded}
            disabled={report === null}
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
            report === null
              ? '正在测量…'
              : `共 ${formatBytes(report.totalBytes)} · 上次测量 ${MEASURED_AT.format(report.measuredAt)}`
          }
          label="数据根"
          warning={failure?.where === 'read' ? failure.text : undefined}
        >
          <Button
            disabled={busy}
            onClick={() => void measure()}
            size="xs"
            type="button"
            variant="soft"
          >
            {busy ? '测量中…' : '重新测量'}
          </Button>
        </SettingRow>

        {expanded
          ? occupied.map((entry) => (
              <SettingRow
                description={LABELS[entry.id]?.description}
                key={entry.id}
                label={LABELS[entry.id]?.label ?? entry.id}
              >
                <span className="settings-row__value">{formatBytes(entry.bytes)}</span>
              </SettingRow>
            ))
          : null}

        {expanded && report?.truncated === true ? (
          <SettingRow
            description="文件数超过上限，上面的数字是「至少这么多」。"
            label="测量被截断"
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="清理">
        <SettingRow
          description="网页与代码的磁盘缓存。清完只是下次加载慢一点，登录态不动。"
          label="内核缓存"
        >
          <Button
            disabled={busy}
            onClick={() => void clear('cache')}
            size="xs"
            type="button"
            variant="soft"
          >
            {busy ? '清理中…' : '清除缓存'}
          </Button>
        </SettingRow>

        <SettingRow
          description="内置浏览器里所有站点的登录态与本地存储，清完要重新登录。"
          label="内置浏览器数据"
        >
          <Button
            disabled={busy}
            onClick={() => {
              setConfirming(true)
            }}
            size="xs"
            type="button"
            variant="dangerSoft"
          >
            清除数据…
          </Button>
        </SettingRow>

        {failure?.where === 'clear' ? (
          <SettingRow description={failure.text} label="上一步没有完成" />
        ) : null}
      </SettingsGroup>

      <ConfirmationDialog
        busy={busy}
        confirmLabel="清除"
        description="内置浏览器里所有站点的登录态与本地存储都会消失，且无法撤销。"
        destructive
        onCancel={() => {
          setConfirming(false)
        }}
        onConfirm={() => {
          void clear('browser')
        }}
        open={confirming}
        title="清除内置浏览器数据？"
      />
    </SettingsPage>
  )
}

/** 跨边界来的失败已经是 ProblemError（ipc-error.ts 折过），它的 message 就是那句话。 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : '未知原因'
}
