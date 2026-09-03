import type { AppUpdateState, AppUpdateStore } from '@poietica/update'

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

export function isBusy(state: AppUpdateState): boolean {
  return state.phase === 'checking' || state.phase === 'downloading'
}

export function hint(state: AppUpdateState): string {
  switch (state.phase) {
    case 'idle':
      return '检查更新'
    case 'checking':
      return '正在检查更新'
    case 'latest':
      return '已是最新版本'
    case 'available':
      return `更新 ${state.version} 可用`
    case 'downloading':
      return state.percent === null
        ? `正在下载 ${state.version}`
        : `正在下载 ${state.version} · ${state.percent}%`
    case 'ready':
      return `${state.version} 已就绪，点击重启安装`
  }
}

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
