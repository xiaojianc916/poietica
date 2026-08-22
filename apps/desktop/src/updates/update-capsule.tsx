import type { AppUpdateState, AppUpdateStore } from '@poietica/desktop-adapters'
import { Tooltip, TooltipContent, TooltipTrigger } from '@poietica/ui'
import { ArrowDown, RefreshCw } from 'lucide-react'
import { type CSSProperties, useSyncExternalStore } from 'react'

import './update-capsule.css'

export interface UpdateCapsuleProps {
  readonly store: AppUpdateStore
}

/**
 * 侧栏底部的更新胶囊：读一份状态，画一枚控件，把点击转发回去，自己不记任何东西。
 *
 * 状态在 AppUpdateStore 里，寿命是进程（见 shell/app-shell.tsx）。这一层必须是纯投影
 * —— 胶囊挂在 sidebarFooterSlot 上，而那个插槽在设置态会被 sidebarOverride 顶替，
 * React 按位置协调，等于一次卸载重挂；状态若留在这里，切一次设置页就丢一次下载。
 *
 * 每个相位渲染它自己该是的元素：能按的相位才有 button，下载中是 progressbar。于是
 * 「下载中不能按」是结构事实，不需要一个 onClick 为空的按钮杵在那里装死。
 */
export function UpdateCapsule({ store }: UpdateCapsuleProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  if (state.phase === 'idle') {
    return null
  }

  if (state.phase === 'checking' || state.phase === 'latest') {
    return <CheckNote phase={state.phase} />
  }

  if (state.phase === 'downloading') {
    return <DownloadProgress percent={state.percent} version={state.version} />
  }

  /*
   * key 让 available → ready 走一次卸载重挂。
   *
   * 到达提示是一次性动画，CSS animation 只在元素挂载时播一遍；两个相位共用同一个
   * DOM 节点，就意味着「下载好了」这一下永远不会出现。
   */
  return <UpdateAction key={state.phase} state={state} store={store} />
}

type Actionable = Extract<AppUpdateState, { phase: 'available' | 'ready' }>

interface UpdateActionProps {
  readonly state: Actionable
  readonly store: AppUpdateStore
}

function UpdateAction({ state, store }: UpdateActionProps) {
  const ready = state.phase === 'ready'

  /* 胶囊上只有两个字，说不清将要发生什么；完整那句同时喂给读屏与气泡。 */
  const hint = ready ? `重启以更新到 ${state.version}` : `下载更新 ${state.version}`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={hint}
            className="update-capsule"
            data-phase={state.phase}
            onClick={ready ? store.relaunch : store.download}
            type="button"
          >
            <span className="update-capsule__text">
              <span className="update-capsule__label">{ready ? '重启' : '更新'}</span>
            </span>

            <span className="update-capsule__glyph">
              {ready ? <RefreshCw aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
            </span>
          </button>
        }
      />

      <TooltipContent side="top">{hint}</TooltipContent>
    </Tooltip>
  )
}

/**
 * 按下「检查更新」之后的两句回话。
 *
 * 不是按钮：这两个相位没有动作可做。role="status" 让读屏在它出现时念一遍，
 * 外形与胶囊的其余相位共用同一套类名。
 */
function CheckNote({ phase }: { readonly phase: 'checking' | 'latest' }) {
  const hint = phase === 'checking' ? '正在检查更新' : '已是最新版本'

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span aria-label={hint} className="update-capsule" data-phase={phase} role="status">
            <span className="update-capsule__text">
              <span className="update-capsule__label">
                {phase === 'checking' ? '检查中' : '最新'}
              </span>
            </span>

            <span className="update-capsule__glyph">
              <RefreshCw aria-hidden="true" />
            </span>
          </span>
        }
      />

      <TooltipContent side="top">{hint}</TooltipContent>
    </Tooltip>
  )
}

/* 比例交给 CSS 做 scaleX；传字符串，因为自定义属性不参与 React 的单位推断。 */
type ProgressStyle = CSSProperties & { readonly '--update-capsule-progress'?: string }

interface DownloadProgressProps {
  readonly percent: number | null
  readonly version: string
}

/**
 * 下载中。
 *
 * 进度未知是一个真实相位：拿到 Content-Length 之前 updater 给不出百分比，所以那条
 * 契约上的进度是 number | null（见 desktop-adapters/src/app-update.ts）。未知时不写
 * aria-valuenow —— WAI-ARIA 1.2 规定 progressbar 缺这个属性即表示不确定。样式读的
 * 也是这个属性（见 update-capsule.css），语义与视觉共用一个真相，不另立 data-*。
 */
function DownloadProgress({ percent, version }: DownloadProgressProps) {
  const hint = percent === null ? `正在下载 ${version}` : `正在下载 ${version}，${percent}%`

  const style: ProgressStyle =
    percent === null ? {} : { '--update-capsule-progress': String(percent / 100) }

  return (
    <div
      aria-label={hint}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent ?? undefined}
      className="update-capsule"
      data-phase="downloading"
      role="progressbar"
      style={style}
    >
      <span className="update-capsule__fill" />

      <span className="update-capsule__text">
        <span className="update-capsule__label">
          {percent === null ? (
            '下载中'
          ) : (
            <>
              <span className="update-capsule__value">{percent}</span>%
            </>
          )}
        </span>
      </span>

      <span className="update-capsule__glyph">
        <ArrowDown aria-hidden="true" />
      </span>
    </div>
  )
}
