import { Banner, Button, InlineSpinner, SettingRow, SettingsGroup } from '@poietica/design-system'
import { useEffect, useRef, useState } from 'react'
import type { PythonStatus } from '../contract'
import type { PythonApi } from './api'
import './python-kernel.css'

/* 状态、一步安装。它没有自己的一页，住在通用页里 —— 装的是 agent 跑代码要用的东西，与「这台软件怎么陪你干活」同一件事。
 * 解释器不再随产品走：默认复用系统里已经装好的 Python，没有或太旧时由这里装官方最新稳定版。没有「删除」：
 * 删掉的会是用户电脑上的 Python，不是产品的数据。 */
const POLL_INTERVAL_MS = 1_000

const READ_FAILED = '读不到本机 Python 的状态；稍后重试。'

interface Copy {
  readonly description: string
  /** 失败原因挂在行的 warning 区；成功状态没有它。 */
  readonly failure: string | null
  readonly detail: string | null
}

/** legacy ACTIONS；`remove` 已去掉 —— 系统 Python 不归产品删。 */
type ActionKind = 'none' | 'install' | 'repair'

function actionOf(status: PythonStatus | null): { readonly kind: ActionKind; readonly label: string } {
  if (status === null) return { kind: 'none', label: '' }

  switch (status.state) {
    case 'absent':
    case 'outdated':
      return { kind: 'install', label: '安装' }
    case 'failed':
      return { kind: 'repair', label: '重新安装' }
    default:
      return { kind: 'none', label: '' }
  }
}

function copyOf(status: PythonStatus | null): Copy {
  if (status === null) {
    return { description: '正在读取本机 Python 的状态…', failure: null, detail: null }
  }

  const failure = status.error === null ? null : failureText(status.error.message)
  const version = status.version

  switch (status.state) {
    case 'absent':
      return { description: '还没有可用的系统 Python；点「安装」会装到系统里供 agent 使用', failure, detail: null }
    case 'outdated':
      return {
        description: `${version === null ? '本机 Python' : `本机 Python ${version}`} 版本过低；点「安装」会自动升级到最新稳定版`,
        failure,
        detail: null,
      }
    case 'downloading':
      return {
        description: '正在下载 Python 安装包，这一步只发生一次',
        failure,
        detail: `已下载 ${Math.round((status.progress ?? 0) * 100)}%`,
      }
    case 'installing':
      return { description: '正在安装 Python，请稍候', failure, detail: null }
    case 'ready':
      return {
        description: `${version === null ? '已就绪' : `已就绪（Python ${version}）`}；agent 跑 Python 代码时用这一份解释器`,
        failure,
        detail: null,
      }
    case 'failed':
      return { description: '上一次安装没有完成；点「安装」重试', failure, detail: null }
  }
}

/** 失败原因原样上屏：那是排障唯一拿得到的那句话。前缀只加一次。 */
function failureText(reason: string): string {
  const detail = reason.trim().replace(/^(?:安装失败[：:]\s*)+/u, '')

  return `安装失败：${detail === '' ? '上游没有报出失败原因。' : detail}`
}

export function PythonKernelGroup({ api }: { readonly api: PythonApi }) {
  const [status, setStatus] = useState<PythonStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState(false)
  /* 这一轮装机是用户自己点的吗。只有它才配在装好后报一声 —— 打开设置页时早装好了，那不是一次「装好了」，报到人脸上就是假消息。 */
  const asked = useRef(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    void api.status().then(
      (next) => {
        if (live.current) setStatus(next)
      },
      (cause: unknown) => {
        if (live.current) setFailure(reasonOf(cause))
      },
    )
    return api.onStatusChanged((next) => {
      if (live.current) setStatus(next)
    }).dispose
  }, [api])

  const working = status?.state === 'downloading' || status?.state === 'installing'

  useEffect(() => {
    if (working !== true) {
      return
    }

    const timer = setInterval(() => {
      void api.status().then(
        (next) => {
          if (live.current) setStatus(next)
        },
        () => undefined,
      )
    }, POLL_INTERVAL_MS)

    return () => {
      clearInterval(timer)
    }
  }, [api, working])

  const act = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)

    try {
      /* 装机是后台跑的，这条命令交回时状态已经定局；过程中界面靠状态通知与按秒重读。 */
      const next = await api.install()

      if (live.current) {
        asked.current = true
        setStatus(next)
      }
    } catch (cause) {
      if (live.current) {
        asked.current = false
        setFailure(reasonOf(cause))
      }
    } finally {
      if (live.current) {
        setBusy(false)
      }
    }
  }

  /* 点过安装、如今就绪：报一声，并把这一轮标记清掉（重读不会再报第二次）。 */
  const ready = status?.state === 'ready'

  useEffect(() => {
    if (ready === true && asked.current && live.current) {
      asked.current = false
      setInstalled(true)
    }
  }, [ready])

  const copy = copyOf(status)
  const action = actionOf(status)

  return (
    <SettingsGroup title="运行时">
      <SettingRow description={copy.description} label="Python 内核" warning={copy.failure ?? failure ?? undefined}>
        {working === true ? (
          <span className="python-kernel__busy">
            <InlineSpinner />
            {status?.state === 'installing' ? '安装中' : '下载中'}
          </span>
        ) : null}

        {action.kind === 'none' || working === true ? null : (
          <Button
            disabled={busy}
            onClick={() => {
              void act()
            }}
            size="xs"
            type="button"
            variant="soft"
          >
            {busy ? '处理中…' : action.label}
          </Button>
        )}
      </SettingRow>

      {working === true ? <IndeterminateProgress label={copy.detail ?? '正在安装'} /> : null}

      {copy.detail === null ? null : (
        <div className="settings-row">
          <div className="settings-row__copy">
            <p className="python-kernel__detail">{copy.detail}</p>
          </div>
        </div>
      )}

      {installed ? (
        <Banner
          onDone={() => {
            setInstalled(false)
          }}
          text="Python 安装成功"
          tone="success"
        />
      ) : null}
    </SettingsGroup>
  )
}

/**
 * 不确定进度条：下载有百分比，安装阶段没有。不给 aria-valuenow 是有意的 —— 那正是「progressbar 不知道进度」的表达，
 * 报一个数字就是编一个百分比出来。
 */
function IndeterminateProgress({ label }: { readonly label: string }) {
  return (
    <div aria-label={label} className="python-kernel__progress" role="progressbar">
      <div className="python-kernel__progress-bar" />
    </div>
  )
}

/** 跨边界来的失败已经是折过的错误，它的 message 就是那句话。 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : READ_FAILED
}
