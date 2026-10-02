import { Button, InlineSpinner } from '@poietica/design-system'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PythonKernelGateway, PythonKernelStatus } from './python-kernel/gateway'
import { pythonKernelAction, pythonKernelCopy } from './python-kernel-view'
import { SettingRow, SettingsGroup, SettingsPage } from './settings-primitives'
import './python-kernel-settings.css'

/*
 * 内置 Python 内核这一页：状态、一步安装、删干净。
 *
 * 状态是原生侧从盘上推出来的那一份，这里不缓存、不推断；安装是后台跑的一条命令，
 * 所以装机期间按秒重读，读完为止。没有事件推送 —— 一条一秒一次的读换来一个不需要
 * 第二套订阅协议的页面。
 */

/** 装机期间的重读节拍。装完就停：状态不再是 installing 就没有下一次。 */
const POLL_INTERVAL_MS = 1_000

const READ_FAILED = '读不到本机 Python 内核的状态；稍后重试。'

export interface PythonKernelSettingsProps {
  /* 由组合根注入且**引用稳定**：这个组件的读以它为依赖，每次渲染换一个新对象会让它反复重读。 */
  readonly gateway: PythonKernelGateway
}

export function PythonKernelSettings({ gateway }: PythonKernelSettingsProps) {
  const [status, setStatus] = useState<PythonKernelStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  const read = useCallback(async () => {
    try {
      const next = await gateway.status()

      if (live.current) {
        setStatus(next)
      }
    } catch (cause) {
      if (live.current) {
        setFailure(reasonOf(cause))
      }
    }
  }, [gateway])

  useEffect(() => {
    void read()
  }, [read])

  const installing = status?.state === 'installing'

  useEffect(() => {
    if (!installing) {
      return
    }

    const timer = setInterval(() => {
      void read()
    }, POLL_INTERVAL_MS)

    return () => {
      clearInterval(timer)
    }
  }, [installing, read])

  const act = async (kind: 'install' | 'repair' | 'remove'): Promise<void> => {
    setBusy(true)
    setFailure(null)

    try {
      const next = kind === 'remove' ? await gateway.remove() : await gateway.install()

      if (live.current) {
        setStatus(next)
      }
    } catch (cause) {
      if (live.current) {
        setFailure(reasonOf(cause))
      }
    } finally {
      if (live.current) {
        setBusy(false)
      }
    }
  }

  const copy = pythonKernelCopy(status)
  const action = pythonKernelAction(status)

  return (
    <SettingsPage>
      <SettingsGroup title="运行时">
        <SettingRow
          description={copy.description}
          label="Python 内核"
          warning={copy.failure ?? action.warning ?? failure ?? undefined}
        >
          {installing ? (
            <span className="python-kernel__busy">
              <InlineSpinner />
              准备中
            </span>
          ) : null}

          {action.kind === 'none' || installing ? null : (
            <Button
              disabled={busy}
              onClick={() => {
                void act(action.kind === 'remove' ? 'remove' : 'install')
              }}
              size="xs"
              type="button"
              variant={action.kind === 'remove' ? 'outline' : 'soft'}
            >
              {busy ? '处理中…' : action.label}
            </Button>
          )}
        </SettingRow>

        {installing ? <IndeterminateProgress label={copy.detail ?? '正在准备'} /> : null}

        {copy.detail === null || copy.detailLabel === null ? null : (
          <div className="settings-row">
            <div className="settings-row__copy">
              <strong>{copy.detailLabel}</strong>

              <p className="python-kernel__detail">{copy.detail}</p>
            </div>
          </div>
        )}
      </SettingsGroup>
    </SettingsPage>
  )
}

/**
 * 不确定进度条：上游不吐字节进度，所以这里只有「在动」这一件事可画。
 *
 * 不给 aria-valuenow 是有意的 —— 那正是「progressbar 不知道进度」的表达，
 * 报一个数字就是编一个百分比出来。
 */
function IndeterminateProgress({ label }: { readonly label: string }) {
  return (
    <div aria-label={label} className="python-kernel__progress" role="progressbar">
      <div className="python-kernel__progress-bar" />
    </div>
  )
}

/** 跨边界来的失败已经是 ProblemError（ipc-error.ts 折过），它的 message 就是那句话。 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : READ_FAILED
}
