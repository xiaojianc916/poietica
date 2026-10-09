import type { UpdateState } from '../contract'

/*
 * 横幅这一刻该说的一句话（07 页 §15E，另加手动检查的「已是最新」档）。
 *
 * 与 legacy 的 `update-phase.ts` 同一套判据，相位换成新状态机的七个：
 *   - `latest`（不是相位，是手动检查刚回话「已是最新」的一次性标记，见 store 的
 *     `latest`）：说完自己走 —— legacy 的 `latest` 档同样是「说完回 idle」；
 *   - `available`：发现新版本，**由人决定下不下**（Host 的 autoDownload 是 false），所以
 *     这一档有「下载」与「稍后」两个动作；
 *   - `downloading`：「稍后」不给 —— 下载已经在跑，后面只等结果；
 *   - `ready`：带唯一的安装入口，「稍后」同样不给（它一走人就没法装）。
 *
 * 这些都是纯函数：横幅组件只做投影，判据能被单测钉住。
 */

export type UpdateBannerAction = 'download' | 'later' | 'install'

export interface UpdateBannerNotice {
  /**
   * 与 state.version 同源；版本号缺席时不画横幅（没有可说的对象）。
   * 「已是最新」那一档没有版本号可说，给空串（`dismissed` 只认版本号，不会误伤它）。
   */
  readonly version: string
  readonly text: string
  readonly actions: readonly UpdateBannerAction[]
  /** 语气；「已是最新」是 success（legacy 的绿勾），其余不给 */
  readonly tone?: 'success'
  /** 有确数才给（0-1）；没有确数就不画轨，别假装在动 */
  readonly progress?: number
  /** 下载中要一枚转着的字形，与「正在下载」同义 */
  readonly spinning?: boolean
  /**
   * 停在那儿**不自己走**。
   *
   * 判据是 legacy 的「有没有未了的事」，不是时间长短：
   *   - `downloading`：进度淡出等于把人晾在「不知道下到哪了」；
   *   - `ready`：这一句带着**唯一的**安装入口，它一走人就没法装了。
   *
   * `available` 不常驻：它只是一句通知（要下就点「下载」，不点就等它自己走，"稍后"与
   * 自动淡出是同一件事）。常驻档在 Banner 那里报 `holdMs: null` —— 连计时器都不装，
   * 不是「一个够长的毫秒数」。
   */
  readonly persistent?: boolean
}

export function updateBannerNotice(
  state: UpdateState | null,
  dismissed: string | null,
  latest = false,
): UpdateBannerNotice | null {
  /*
   * 「已是最新」是手动检查的答复，不是 Host 的一个相位（`idle` 分不出「没查过」与
   * 「查过没有新版本」）—— 判据因此放在版本号检查**之前**。
   */
  if (latest && (state === null || state.phase === 'idle')) {
    return { version: '', text: '已是最新版本', actions: [], tone: 'success' }
  }
  if (state === null || state.version === null) return null
  const version = state.version

  switch (state.phase) {
    case 'available':
      /* 「稍后」只对本运行内的这一版生效：换一版是另一件事，横幅该回来说。 */
      if (dismissed === version) return null
      return { version, text: `发现新版本 v${version}`, actions: ['download', 'later'] }
    case 'downloading': {
      const percent = state.progress === null ? null : Math.round(state.progress * 100)
      return {
        version,
        text: percent === null ? `正在下载 v${version}…` : `正在下载 v${version} · ${String(percent)}%`,
        actions: [],
        spinning: true,
        persistent: true,
        ...(state.progress === null ? {} : { progress: state.progress }),
      }
    }
    case 'ready':
      return { version, text: '新版本已下载', actions: ['install'], persistent: true }
    default:
      /* disabled / idle / checking / error 都没有要说的话。 */
      return null
  }
}

/**
 * 这一刻该不该画横幅：有话可说就画。
 *
 * 判据与 `updateBannerNotice` 同源，所以「画不画」与「画什么」不会分家 —— 分工是
 * **组件自己**按它决定渲不渲染（通用 Banner 由各功能自己挂，外壳不再代持可见性）。
 */
export function updateBannerVisible(state: UpdateState | null, dismissed: string | null, latest = false): boolean {
  return updateBannerNotice(state, dismissed, latest) !== null
}
