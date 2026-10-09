import { Banner, Button, ConfirmationDialog, InlineSpinner, SettingRow, SettingsGroup } from '@poietica/design-system'
import { useEffect, useRef, useState } from 'react'
import type { PythonStatus } from '../contract'
import type { PythonApi } from './api'
import './python-kernel.css'

/*
 * 内置 Python 内核那一组：状态、一步安装、删干净。它没有自己的一页，住在通用页里 ——
 * 装的是 agent 跑代码要用的东西，与「这台软件怎么陪你干活」同一件事。
 *
 * **迁移自** legacy `packages/settings/src/ui/python-kernel-settings.tsx` 与
 * `python-kernel-view.ts`：分组名（运行时）、行标签（Python 内核）、说明文案、按钮标签、
 * 忙碌标记、不确定进度条、成功横幅与删除确认弹窗逐条照旧。换掉的只有数据来源 ——
 * legacy 读原生侧的 `python_kernel_status` 轮询，这里读 python 功能的契约
 * （`python.status` / `python.install` / `python.remove` + `python.statusChanged`）。
 */

/** 装机期间的重读节拍。装完就停：状态不再是 downloading / installing 就没有下一次。 */
const POLL_INTERVAL_MS = 1_000

const READ_FAILED = '读不到本机 Python 内核的状态；稍后重试。'

/** 删除的代价。**只在确认弹窗里说**，不挂在行上（legacy 同此）。 */
const REMOVE_WARNING = '删除会连同 agent 设置里的 python.interpreter 一起清空；下次要用得重新安装。'

interface Copy {
  readonly description: string
  /** 失败原因，排在任何状态说明之前；没有失败就是 null。 */
  readonly failure: string | null
  /** 第二行的内容：当前这一步。 */
  readonly detail: string | null
}

/*
 * 五档状态到文案的那一处映射（legacy `python-kernel-view.ts` 的 DESCRIPTIONS）。
 * 新契约的档位名与 legacy 不同（absent / downloading / installing / ready / failed
 * 对 notInstalled / installing / ready / broken），文案一个字未改。
 */
const DESCRIPTIONS: Readonly<Record<PythonStatus['state'], string>> = {
  absent: '让 agent 用它自带的 Python 跑代码，不必另装一个解释器',
  downloading: '正在准备解释器，这一步只发生一次',
  installing: '正在准备解释器，这一步只发生一次',
  ready: '已就绪；agent 跑 Python 代码时用这一份解释器',
  failed: '这份安装不完整，解释器起不来',
}

/** 这一格此刻该给用户看的那颗按钮（legacy ACTIONS）。 */
type ActionKind = 'none' | 'install' | 'repair' | 'remove'

function actionOf(status: PythonStatus | null): { readonly kind: ActionKind; readonly label: string } {
  if (status === null) return { kind: 'none', label: '' }

  switch (status.state) {
    case 'absent':
      return { kind: 'install', label: '安装' }
    case 'ready':
      return { kind: 'remove', label: '删除' }
    case 'failed':
      return { kind: 'repair', label: '重新安装' }
    default:
      return { kind: 'none', label: '' }
  }
}

function copyOf(status: PythonStatus | null): Copy {
  if (status === null) {
    return { description: '正在读取本机 Python 内核的状态…', failure: null, detail: null }
  }

  const failure = status.error === null ? null : failureText(status.error.message)
  const description = (DESCRIPTIONS as Record<string, string | undefined>)[status.state]

  if (description === undefined) {
    return { description: READ_FAILED, failure, detail: null }
  }

  return {
    description,
    failure,
    detail: status.state === 'downloading' ? `已下载 ${Math.round((status.progress ?? 0) * 100)}%` : null,
  }
}

/** 失败原因原样上屏：那是排障唯一拿得到的那句话。前缀只加一次（legacy `failureText`）。 */
function failureText(reason: string): string {
  const detail = reason.trim().replace(/^(?:安装失败[：:]\s*)+/u, '')

  return `安装失败：${detail === '' ? '上游没有报出失败原因。' : detail}`
}

export function PythonKernelGroup({ api }: { readonly api: PythonApi }) {
  const [status, setStatus] = useState<PythonStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const [installed, setInstalled] = useState(false)
  /* 这一轮装机是用户自己点的吗。只有它才配在装好后报一声 —— 打开设置页时早装好了，
   * 那不是一次「装好了」，报到人脸上就是假消息（legacy 同此）。 */
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

  const act = async (kind: 'install' | 'repair' | 'remove'): Promise<void> => {
    setBusy(true)
    setFailure(null)
    setConfirmingRemoval(false)

    try {
      /* 装机是后台跑的，这条命令交回时状态还没变；装没装好由上面那次按秒重读认出来。 */
      let next: PythonStatus

      if (kind === 'remove') {
        await api.remove()
        next = await api.status()
      } else {
        next = await api.install()
      }

      if (live.current) {
        asked.current = kind !== 'remove'
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
            准备中
          </span>
        ) : null}

        {action.kind === 'none' || working === true ? null : (
          <Button
            disabled={busy}
            onClick={() => {
              /* 删除会连 agent 那格设置一起清空，先问一句再动手。 */
              if (action.kind === 'remove') {
                setConfirmingRemoval(true)

                return
              }

              void act(action.kind === 'repair' ? 'repair' : 'install')
            }}
            size="xs"
            type="button"
            variant={action.kind === 'remove' ? 'dangerSoft' : 'soft'}
          >
            {busy ? '处理中…' : action.label}
          </Button>
        )}
      </SettingRow>

      {working === true ? <IndeterminateProgress label={copy.detail ?? '正在准备'} /> : null}

      {copy.detail === null || action.kind === 'remove' ? null : (
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
          text="Python内核安装成功"
          tone="success"
        />
      ) : null}

      <ConfirmationDialog
        busy={busy}
        confirmLabel="删除"
        description={REMOVE_WARNING}
        destructive
        onCancel={() => {
          setConfirmingRemoval(false)
        }}
        onConfirm={() => {
          void act('remove')
        }}
        open={confirmingRemoval}
        title="删除内置 Python 内核？"
      />
    </SettingsGroup>
  )
}

/**
 * 不确定进度条：上游不吐字节进度，所以这里只有「在动」这一件事可画（legacy 同名组件）。
 *
 * 不给 aria-valuenow 是有意的 —— 那正是「progressbar 不知道进度」的表达，报一个数字
 * 就是编一个百分比出来。
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
