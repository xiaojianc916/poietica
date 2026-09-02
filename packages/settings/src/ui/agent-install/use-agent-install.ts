import type { AgentInstallStatus, AgentSettings } from '@poietica/settings'
import { useCallback, useEffect, useState } from 'react'
import { describeAgentCliFailure } from './agent-cli-text'

/**
 * 这一行该不该出现一颗按钮，上面写什么，以及按下之后发生了什么。
 *
 * 检测本身在原生侧带 24 小时缓存，所以这里挂载即问：命中缓存的那一次既不起进程也不
 * 走网络。这一层不再叠第二层缓存 —— 两个都自称权威的缓存，早晚会说两套话。
 *
 * note 与 error 是两种不同的话。error 是「这次操作失败了」，note 是「这一行此刻的
 * 处境」：装完了、装在我们管不着的地方、查不到最新版。此前两者都被归进「没有可做的
 * 事」而一并静默，于是更新成功与压根没检测到在屏幕上是同一片空白。静默可以是一种
 * 状态的表现，不能是四种状态共用的表现。
 */
export interface AgentInstallView {
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

/**
 * 没有按钮可按时，这一行的处境。
 *
 * unmanaged 是档案根本没声明安装方式，对它而言「更新」这个概念不存在，安静是对的；
 * 另外两种都是用户需要知道的事实。
 */
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

export function useAgentInstall(store: AgentSettings, agentId: string): AgentInstallView {
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
      /* 查不到状态就当没这回事：这一行不该因为一次检测失败而多出一句报错。 */
      () => undefined,
    )

    return () => {
      live = false
    }
  }, [agentId, store])

  const run = useCallback(() => {
    /* 按下的这一刻是安装还是更新，装完之后就问不出来了，先记下来。 */
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

        /*
         * 落地版本真的变了才刷新模型清单。这条通道会让整页重读一遍配置、重起一次子
         * 进程取清单，一次「点了但什么都没变」不值得让屏幕闪这么一下。
         */
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
    return {
      action: state === 'outdated' ? 'update' : 'install',
      label: state === 'outdated' ? '正在更新…' : '正在安装…',
      note: null,
      busy: true,
      error: null,
      run,
    }
  }

  if (state === 'missing') {
    return { action: 'install', label: '安装', note: null, busy: false, error, run }
  }

  if (state === 'outdated') {
    const version = status?.latestVersion ?? ''

    return {
      action: 'update',
      label: version.length > 0 ? `更新到 ${version}` : '更新',
      note: null,
      busy: false,
      error,
      run,
    }
  }

  /* 没有按钮可按。刚做完的那件事优先，其次才是这一行长期的处境。 */
  const note = outcome ?? describeState(status)

  return error === null && note === null ? IDLE : { ...IDLE, note, error, run }
}
