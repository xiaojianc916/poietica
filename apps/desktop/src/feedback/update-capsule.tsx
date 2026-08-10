import type { AppUpdateState, AppUpdateStore } from '@poietica/desktop-adapters'
import { ArrowDown, RefreshCw as Refresh, LoaderCircle as Spinner } from 'lucide-react'
import { useSyncExternalStore } from 'react'

import './update-capsule.css'

export interface UpdateCapsuleProps {
  readonly store: AppUpdateStore
}

/**
 * 侧栏底部的更新胶囊。只读一份状态，自己不记任何东西。
 *
 * 它此前既是视图也是状态机：检查节奏、下载进度、失败回退全在它的 useState 里。
 * 而它挂在一个会被条件替换的插槽上（WorkspaceContainer 的 sidebarFooterSlot 同时
 * 出现在常态侧栏和设置态的 sidebarOverride 里），React 按位置协调 —— 打开设置就是
 * 一次卸载重挂，那台状态机连同正在跑的下载一起被抹掉。
 *
 * 现在状态在 AppUpdateStore 里，寿命是进程。这一层只剩三件事：读、画、把点击转发
 * 回去。切设置页、折叠侧栏、以后任何布局改动，都动不了下载。
 *
 * 三态原地切换，不移动、不夺焦、不遮挡；不可关闭，与 VS Code（齿轮蓝点）、Chrome
 * （菜单变色）、Zed、Slack 一致 —— 一个 28px 的角落控件不抢任何东西，给它一个关闭
 * 按钮只有一个后果：第一次看见就被顺手关掉，此后再也收不到安全更新。
 */
export function UpdateCapsule({ store }: UpdateCapsuleProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  if (state.phase === 'idle') {
    return null
  }

  const busy = state.phase === 'downloading'

  return (
    <div className="update-capsule" data-phase={state.phase}>
      <button
        aria-label={hintOf(state)}
        className="update-capsule__button"
        onClick={busy ? undefined : actionOf(state, store)}
        title={hintOf(state)}
        type="button"
      >
        <span className="update-capsule__label">{labelOf(state)}</span>

        <span className="update-capsule__icon">{iconOf(state)}</span>
      </button>
    </div>
  )
}

type Visible = Exclude<AppUpdateState, { phase: 'idle' }>

/* 胶囊上的字。下载中是纯数字，宽度由 CSS 钉死，所以它不会把胶囊撑长。 */
function labelOf(state: Visible): string {
  switch (state.phase) {
    case 'available':
      return 'Update'

    case 'downloading':
      return state.percent === null ? '···' : `${String(state.percent)}%`

    case 'ready':
      return 'Restart'
  }
}

/* 悬停与读屏听到的那一句：胶囊上那个词太短，说不清要发生什么。 */
function hintOf(state: Visible): string {
  switch (state.phase) {
    case 'available':
      return `下载 ${state.version}`

    case 'downloading':
      return `正在下载 ${state.version}`

    case 'ready':
      return `重启以更新到 ${state.version}`
  }
}

function iconOf(state: Visible) {
  switch (state.phase) {
    case 'available':
      return <ArrowDown aria-hidden="true" />

    case 'downloading':
      return <Spinner aria-hidden="true" className="update-capsule__spinner" />

    case 'ready':
      return <Refresh aria-hidden="true" />
  }
}

/*
 * 点了就做，两处都不再问。
 *
 * 下载本来就是可撤销的（不装就等于没发生），为它加一道确认只是多一次点击；重启
 * 此前挂着一个 ConfirmationDialog，而这个应用没有未保存的文档要抢救 —— 那句"没有
 * 保存的内容会丢失"在文档域移除之后已经不成立了。
 */
function actionOf(state: Visible, store: AppUpdateStore): () => void {
  return state.phase === 'ready' ? store.relaunch : store.download
}
