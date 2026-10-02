import type { AppUpdateState, AppUpdateStore } from '@poietica/update'

/*
 * 发现新版本**自动下载**，只有「装上并重启」这一步要人按。
 *
 * 所以这里的 advance 只剩两条路：ready 就走安装，其余一律重新检查。下载由 store 在
 * 发现新版本时自己起步，不经过这里 —— 没有任何一处调用方需要「请求下载」这个动作。
 */
export function advance(state: AppUpdateState, store: AppUpdateStore): void {
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
    case 'downloading':
      return state.percent === null
        ? `正在下载 ${state.version}`
        : `正在下载 ${state.version} · ${state.percent}%`
    case 'ready':
      return `${state.version} 已就绪，点击重启安装`
  }
}

export interface UpdateNotice {
  /**
   * 同一条结果只报一次。
   *
   * **下载中必须逐版本稳定**：进度每跳一个百分点都换键的话，横幅会被重新挂载、动画
   * 从头开始 —— 一条一直停留的横幅不需要这种「重来一次」。
   */
  readonly key: string
  /** 已经定稿的一句话。 */
  readonly text: string
  /** 接着句子往下说的动作名。下载中与「已是最新」都没有下一步，如实缺席。 */
  readonly action?: string
  /**
   * 语气。**它同时决定左边那个字形**：success 是绿勾（Banner 自带的），不给才是
   * 调用方自己带字形那一档 —— 也就是下载中，那里要一枚转着的箭头。
   */
  readonly tone?: 'success'
  /**
   * 停在那儿不自己走。
   *
   * 下载中与待重启都是「等人或等事」：进度淡出等于把人晾在「不知道下到哪了」，而待重启
   * 那一句带着唯一的安装入口，它一走人就没法装了。
   */
  readonly persistent?: boolean
  /** 有确数的进度才给：没有确数就不画轨，别假装在动。 */
  readonly progress?: number
}

/**
 * 更新这件事此刻该说的一句话；没有话可说的相位交回 null。
 *
 * `idle` / `checking` 还没有结果可说。其余三个相位**都上屏**，而且下载中与待重启是
 * 常驻的（见 `persistent`）。
 */
export function updateNotice(state: AppUpdateState): UpdateNotice | null {
  switch (state.phase) {
    case 'latest':
      return { key: 'latest', text: '已是最新版本', tone: 'success' }
    case 'downloading':
      return {
        key: `downloading:${state.version}`,
        text:
          state.percent === null
            ? `正在下载 ${state.version}…`
            : `正在下载 ${state.version} · ${String(state.percent)}%`,
        persistent: true,
        /* percent 为 null 时不带这一格：界面据此不画轨。 */
        ...(state.percent === null ? {} : { progress: state.percent }),
      }
    case 'ready':
      return {
        key: `ready:${state.version}`,
        text: `${state.version} 已下载，可`,
        action: '重启安装',
        tone: 'success',
        persistent: true,
      }
    case 'idle':
    case 'checking':
      return null
  }
}
