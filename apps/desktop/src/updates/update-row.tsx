import type { AppUpdateState, AppUpdateStore } from '@poietica/desktop-adapters'
import { DropdownMenuItem } from '@poietica/ui'
import { Download, LoaderCircle } from 'lucide-react'
import { useSyncExternalStore } from 'react'

interface UpdateRowProps {
  readonly store: AppUpdateStore
}

/**
 * 帮助菜单里那一行「检查更新」：读一份状态，画一行，把点击交回去，自己不记任何东西。
 *
 * 触发与回话在同一行上，所以这一行不关菜单：人问了一句话，答案要出现在他还在看的
 * 地方。下一步动作跟着相位走 —— 检查、下载、重启是同一行的同一个入口。
 */
export function UpdateRow({ store }: UpdateRowProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const busy = state.phase === 'checking' || state.phase === 'downloading'

  return (
    <DropdownMenuItem
      aria-label={hint(state)}
      closeOnClick={false}
      disabled={busy}
      onClick={() => {
        act(state, store)
      }}
    >
      <Download aria-hidden="true" className="text-muted-foreground" />

      <span>检查更新</span>

      <Note state={state} />
    </DropdownMenuItem>
  )
}

/* 相位就是那道闸：没有第二个布尔在旁边说同一件事。 */
function act(state: AppUpdateState, store: AppUpdateStore): void {
  if (state.phase === 'available') {
    store.download()
    return
  }

  if (state.phase === 'ready') {
    store.relaunch()
    return
  }

  store.check()
}

/** 回话的两种形状：还在问是一个转圈，问完了是一句话。 */
function Note({ state }: { readonly state: AppUpdateState }) {
  if (state.phase === 'idle') {
    return null
  }

  if (state.phase === 'checking') {
    return (
      <LoaderCircle
        aria-hidden="true"
        className="ml-auto size-3.5 animate-spin text-muted-foreground"
      />
    )
  }

  return (
    <span className="ml-auto text-muted-foreground text-xs" role="status">
      {said(state)}
    </span>
  )
}

type Reported = Exclude<AppUpdateState, { readonly phase: 'idle' | 'checking' }>

function said(state: Reported): string {
  switch (state.phase) {
    case 'latest':
      return '未发现'
    case 'available':
      return '发现更新项'
    case 'downloading':
      return state.percent === null ? '下载中' : `${state.percent}%`
    case 'ready':
      return '待重启'
  }
}

/* 行上只有两三个字，说不清将要发生什么；完整那句给读屏。 */
function hint(state: AppUpdateState): string {
  switch (state.phase) {
    case 'idle':
      return '检查更新'
    case 'checking':
      return '正在检查更新'
    case 'latest':
      return '未发现更新'
    case 'available':
      return `发现更新 ${state.version}，点击下载`
    case 'downloading':
      return state.percent === null
        ? `正在下载 ${state.version}`
        : `正在下载 ${state.version}，${state.percent}%`
    case 'ready':
      return `${state.version} 已就绪，点击重启安装`
  }
}
