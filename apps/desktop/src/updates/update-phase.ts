import type { AppUpdateState, AppUpdateStore } from '@poietica/desktop-adapters'

type Available = Extract<AppUpdateState, { readonly phase: 'available' }>
/* 下行体量的两种量级，说给人听。 */
const KIND_LABEL: Record<Available['kind'], string> = {
  full: '完整包',
  patch: '增量包',
}
/** 相位就是那道闸：下一步该做什么只有这一处映射。 */
export function advance(state: AppUpdateState, store: AppUpdateStore): void {
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
/** 正在做的事不接受第二次点击。 */
export function isBusy(state: AppUpdateState): boolean {
  return state.phase === 'checking' || state.phase === 'downloading'
}
/** 完整那一句：胶囊上的文案与读屏念的是同一份。 */
export function hint(state: AppUpdateState): string {
  switch (state.phase) {
    case 'idle':
      return '检查更新'
    case 'checking':
      return '正在检查更新'
    case 'latest':
      return '已是最新版本'
    case 'available':
      return `更新 ${state.version} 可用 · ${KIND_LABEL[state.kind]}`
    case 'downloading':
      return state.percent === null
        ? `正在下载 ${state.version}`
        : `正在下载 ${state.version} · ${state.percent}%`
    case 'ready':
      return `${state.version} 已就绪，点击重启安装`
  }
}
/** 菜单那一行只有三四个字的位置。 */
export function note(state: AppUpdateState): string | null {
  switch (state.phase) {
    case 'idle':
    case 'checking':
      return null
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
