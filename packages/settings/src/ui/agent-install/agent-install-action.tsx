import { Button, InlineSpinner } from '@poietica/design-system'
import { useCallback, useEffect, useState } from 'react'
import type { AgentInstallStatus, AgentSettings } from '../../index'
import { describeAgentCliFailure } from './agent-cli-text'

export interface AgentInstallActionProps {
  readonly store: AgentSettings
  readonly agentId: string
}

/* 挂载即问状态：原生侧带 24 小时缓存，命中缓存不起进程。 */
interface AgentInstallView {
  readonly action: 'none' | 'install' | 'update'
  readonly label: string
  readonly note: string | null
  readonly busy: boolean
  readonly error: string | null
  readonly run: () => void
}

const IDLE: AgentInstallView = {
  action: 'none',
  label: '',
  note: null,
  busy: false,
  error: null,
  run: () => undefined,
}

function describeState(status: AgentInstallStatus | null): string | null {
  switch (status?.state) {
    case 'external':
      return '由其他方式安装，更新请沿用原来的方式'
    case 'unknown':
      return '没能查到最新版本'
    default:
      return null
  }
}

/* 「安装/更新」行：没按钮也不画噪音，但装完的结果与装在别处的说明都要说。 */
export function AgentInstallAction({ store, agentId }: AgentInstallActionProps) {
  const [status, setStatus] = useState<AgentInstallStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)

  useEffect(() => {
    let live = true

    setStatus(null)
    setError(null)
    setOutcome(null)

    void store.loadInstallStatus(agentId).then(
      (next) => {
        if (live) {
          setStatus(next)
        }
      },
      () => undefined,
    )

    return () => {
      live = false
    }
  }, [agentId, store])

  const run = useCallback(() => {
    const verb = status?.state === 'missing' ? '安装' : '更新'
    const before = status?.installedVersion ?? null

    setBusy(true)
    setError(null)
    setOutcome(null)

    void store.runInstall(agentId).then(
      (next) => {
        setBusy(false)
        setStatus(next)
        setOutcome(
          next.installedVersion === null ? `${verb}完成` : `已${verb}到 ${next.installedVersion}`,
        )
        /* 落地版本真的变了才刷新模型清单。 */
        if (next.installedVersion !== before) {
          store.notifyConfigChanged()
        }
      },
      (cause: unknown) => {
        setBusy(false)
        setError(describeAgentCliFailure(cause, '安装没有完成，请重试。'))
      },
    )
  }, [agentId, status, store])

  const state = status?.state

  if (busy) {
    return (
      <Row
        action="update"
        busy
        error={null}
        label={state === 'outdated' ? '正在更新…' : '正在安装…'}
        note={null}
        run={run}
      />
    )
  }

  if (state === 'missing') {
    return <Row action="install" busy={false} error={error} label="安装" note={null} run={run} />
  }

  if (state === 'outdated') {
    const version = status?.latestVersion ?? ''
    return (
      <Row
        action="update"
        busy={false}
        error={error}
        label={version.length > 0 ? `更新到 ${version}` : '更新'}
        note={null}
        run={run}
      />
    )
  }

  const message = error ?? outcome ?? describeState(status)
  return message === null ? null : <Row {...IDLE} error={error} note={message} run={run} />
}

function Row({ action, label, note, busy, error, run }: AgentInstallView) {
  const message = error ?? note
  return (
    <>
      {message === null ? null : <span className="models-row__meta">{message}</span>}
      {busy ? <InlineSpinner /> : null}
      {action === 'none' ? null : (
        <Button disabled={busy} onClick={run} size="xs" type="button" variant="soft">
          {label}
        </Button>
      )}
    </>
  )
}
