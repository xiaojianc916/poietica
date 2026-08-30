import { type FailureCoordinator, failureCoordinator, optionalProperty } from '@poietica/problem'

/* 同时在场的上限。挤出去的那几张已经在诊断日志里，不必再抢屏幕。 */
const MAX_VISIBLE = 3
/* 停留时长 = 底线 + 按字数估的阅读时间，上限收口。中文约 11 字每秒。 */
const MIN_DWELL_MS = 4_000
const MAX_DWELL_MS = 12_000
const MS_PER_CHARACTER = 90
/*
 * 退场动画时长。正本是 --ui-duration-fast（packages/design-system/src/styles/tokens/motion.css）。
 */
const CLOSING_MS = 120
export type NoticePauseReason = 'hover' | 'hidden'
export interface Notice {
  readonly id: string
  readonly title: string
  readonly detail?: string
  readonly closing: boolean
}
/** 读完一条要多久。字数是唯一变量，所以它是纯函数。 */
export function noticeDwellMs(title: string, detail: string | undefined): number {
  const length = title.length + (detail === undefined ? 0 : detail.length)
  return Math.min(MAX_DWELL_MS, MIN_DWELL_MS + length * MS_PER_CHARACTER)
}
interface Presence {
  remaining: number
  startedAt: number
  handle: ReturnType<typeof setTimeout> | null
  closing: boolean
}
/**
 * 屏幕上那几张失败通知。
 *
 * 失败本身归 FailureCoordinator，这里只拥有「还在场吗、还剩多久」：一条通知走完
 * 停留时间就转入退场，退场结束后由 coordinator.dismiss 真正销号 —— 移除仍然只有
 * 那一条写路径。只有 recoverable 会到这里；feature-degraded 的去处是控件变灰
 * （见 shell/app-shell.tsx 的 capabilities），不是弹一张卡片。
 */
export class NoticeStore {
  readonly #coordinator: FailureCoordinator
  readonly #presences = new Map<string, Presence>()
  readonly #listeners = new Set<() => void>()
  readonly #paused = new Set<NoticePauseReason>()
  #notices: readonly Notice[] = []
  constructor(coordinator: FailureCoordinator) {
    this.#coordinator = coordinator
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  getSnapshot = (): readonly Notice[] => this.#notices
  /** 跟着 coordinator 活。装载几次就退订几次。 */
  start = (): (() => void) => {
    const stop = this.#coordinator.subscribe(this.#sync)
    this.#sync()
    return () => {
      stop()
      for (const presence of this.#presences.values()) {
        this.#disarm(presence)
      }
      this.#presences.clear()
      this.#notices = []
    }
  }
  /** 人在读、或者窗口根本没露面，就不要烧停留时间。 */
  setPaused = (reason: NoticePauseReason, paused: boolean): void => {
    const before = this.#paused.size > 0
    if (paused) {
      this.#paused.add(reason)
    } else {
      this.#paused.delete(reason)
    }
    const after = this.#paused.size > 0
    if (after === before) {
      return
    }
    for (const [id, presence] of this.#presences) {
      if (presence.closing) {
        continue
      }
      if (after) {
        presence.remaining = Math.max(0, presence.remaining - (Date.now() - presence.startedAt))
        this.#disarm(presence)
        continue
      }
      this.#arm(id, presence)
    }
  }
  /** 点一下就走。没有叉，整张卡片就是这个动作。 */
  dismiss = (noticeId: string): void => {
    const presence = this.#presences.get(noticeId)
    if (presence === undefined || presence.closing) {
      return
    }
    this.#beginClosing(noticeId, presence)
    this.#publish()
  }
  #sync = (): void => {
    const visible = this.#coordinator.getSnapshot().operations.slice(-MAX_VISIBLE)
    const live = new Set(visible.map((entry) => entry.incident.id))
    /* 被更新的挤出去的那几张也播完退场，别当场消失。 */
    for (const [id, presence] of this.#presences) {
      if (!live.has(id) && !presence.closing) {
        this.#beginClosing(id, presence)
      }
    }
    for (const entry of visible) {
      const id = entry.incident.id
      if (this.#presences.has(id)) {
        continue
      }
      const presence: Presence = {
        remaining: noticeDwellMs(entry.incident.userMessage, readDetail(entry.incident)),
        startedAt: 0,
        handle: null,
        closing: false,
      }
      this.#presences.set(id, presence)
      this.#arm(id, presence)
    }
    this.#publish()
  }
  #arm = (id: string, presence: Presence): void => {
    this.#disarm(presence)
    if (this.#paused.size > 0) {
      return
    }
    presence.startedAt = Date.now()
    presence.handle = setTimeout(() => {
      presence.handle = null
      if (this.#presences.get(id) !== presence || presence.closing) {
        return
      }
      this.#beginClosing(id, presence)
      this.#publish()
    }, presence.remaining)
  }
  #disarm = (presence: Presence): void => {
    if (presence.handle !== null) {
      clearTimeout(presence.handle)
      presence.handle = null
    }
  }
  #beginClosing = (id: string, presence: Presence): void => {
    this.#disarm(presence)
    presence.closing = true
    presence.handle = setTimeout(() => {
      presence.handle = null
      if (this.#presences.get(id) !== presence) {
        return
      }
      this.#presences.delete(id)
      this.#retire(id)
      this.#publish()
    }, CLOSING_MS)
  }
  /* 销号连同比它更旧的一起：那些从没上过屏，已经在诊断日志里，不必再排队。 */
  #retire = (noticeId: string): void => {
    const operations = this.#coordinator.getSnapshot().operations
    const index = operations.findIndex((entry) => entry.incident.id === noticeId)
    if (index < 0) {
      return
    }
    for (const entry of operations.slice(0, index + 1)) {
      this.#coordinator.dismiss(entry.incident.id)
    }
  }
  /* 唯一写点：引用没变就不通知，useSyncExternalStore 的前提。 */
  #publish = (): void => {
    const byId = new Map(
      this.#coordinator.getSnapshot().operations.map((entry) => [entry.incident.id, entry]),
    )
    const next: Notice[] = []
    for (const [id, presence] of this.#presences) {
      const entry = byId.get(id)
      if (entry === undefined) {
        continue
      }
      next.push(
        Object.freeze({
          id,
          title: entry.incident.userMessage,
          closing: presence.closing,
          ...optionalProperty('detail', readDetail(entry.incident)),
        }),
      )
    }
    if (sameNotices(this.#notices, next)) {
      return
    }
    this.#notices = Object.freeze(next)
    for (const listener of [...this.#listeners]) {
      listener()
    }
  }
}
export const noticeStore = new NoticeStore(failureCoordinator)
/* 第二行只在它真说了新东西时才有：与用户那句一样的诊断文本是噪音。 */
function readDetail(incident: {
  readonly userMessage: string
  readonly technicalMessage: string
}): string | undefined {
  const detail = incident.technicalMessage.trim()
  return detail.length > 0 && detail !== incident.userMessage ? detail : undefined
}
function sameNotices(current: readonly Notice[], next: readonly Notice[]): boolean {
  if (current.length !== next.length) {
    return false
  }
  return current.every((notice, index) => {
    const candidate = next[index]
    return (
      candidate !== undefined &&
      notice.id === candidate.id &&
      notice.title === candidate.title &&
      notice.detail === candidate.detail &&
      notice.closing === candidate.closing
    )
  })
}
