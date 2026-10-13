import type { UpdateState } from '../contract'

/* 横幅这一刻该说的一句话。与 legacy 的 `update-phase.ts` 同一套判据，相位换成新状态机的七个：`latest`（不是相位，是手动检查刚回话
 * 「已是最新」的一次性标记）说完自己走；`available` 发现新版本，**由人决定下不下**（Host 的 autoDownload 是 false），所以有「下载」与
 * 「稍后」两个动作；`downloading` 与 `ready` 不给「稍后」—— 前者已在跑，后者带着唯一的安装入口，一走人就没法装。 */

export type UpdateBannerAction = 'download' | 'later' | 'install'

export interface UpdateBannerNotice {
  /** 版本号缺席时不画横幅（没有可说的对象）；「已是最新」那一档给空串（`dismissed` 只认版本号，不会误伤它）。 */
  readonly version: string
  readonly text: string
  readonly actions: readonly UpdateBannerAction[]
  readonly tone?: 'success'
  readonly progress?: number
  readonly spinning?: boolean
  /** 停在那儿**不自己走**：判据是 legacy 的「有没有未了的事」，不是时间长短 —— `downloading` 淡出等于把人晾在「不知道下到哪了」，
   * `ready` 带着**唯一的**安装入口。常驻档在 Banner 那里报 `holdMs: null`，连计时器都不装。 */
  readonly persistent?: boolean
}

export function updateBannerNotice(
  state: UpdateState | null,
  dismissed: string | null,
  latest = false,
): UpdateBannerNotice | null {
  /* 「已是最新」是手动检查的答复，不是 Host 的一个相位（`idle` 分不出「没查过」与「查过没有新版本」）—— 判据因此放在版本号检查**之前**。 */
  if (latest && (state === null || state.phase === 'idle')) {
    return { version: '', text: '已是最新版本', actions: [], tone: 'success' }
  }
  if (state === null || state.version === null) return null
  const version = state.version

  switch (state.phase) {
    case 'available':
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
      return null
  }
}

/** 判据与 `updateBannerNotice` 同源，所以「画不画」与「画什么」不会分家 —— 组件自己按它决定渲不渲染（通用 Banner 由各功能自己挂）。 */
export function updateBannerVisible(state: UpdateState | null, dismissed: string | null, latest = false): boolean {
  return updateBannerNotice(state, dismissed, latest) !== null
}
