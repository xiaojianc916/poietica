import { createId, type Disposable } from '@poietica/foundation'
import { describeError } from './errors'
import { createValue, type Observable } from './observable'

export type BannerSeverity = 'info' | 'success' | 'warning' | 'error'

/** 一条横幅通知。同一时刻屏幕顶部只留最新的一条。 */
export interface BannerNotice {
  readonly id: string
  readonly severity: BannerSeverity
  readonly title: string
  readonly detail?: string
  readonly action?: { readonly label: string; readonly run: () => void }
  /** 停满多久开始淡出；由外壳交给 design-system 的 Banner。 */
  readonly holdMs: number
}

export interface BannerService extends Observable<readonly BannerNotice[]> {
  show(notice: Omit<BannerNotice, 'id' | 'holdMs'> & { holdMs?: number }): Disposable
  error(error: unknown, title?: string): Disposable
  dismiss(id: string): void
}

/** 同一内容在此窗口内重复出现只显示一次。 */
const DEDUPE_MS = 3_000

/** 错误要多留一会儿让人读完；其余够看完一句话。 */
const DEFAULT_HOLD_MS: Readonly<Record<BannerSeverity, number>> = {
  info: 4_000,
  success: 4_000,
  warning: 5_000,
  error: 6_000,
}

/**
 * 横幅服务：只持有「当前这一条」，不排卡片、不叠楼层。
 *
 * 停留与退场由 design-system 的 Banner 自己计时，onDone 回来调 dismiss；服务不再另装
 * setTimeout —— 两套时钟一定会把横幅卸在淡出一半的地方。
 */
export function createBannerService(errorMessages: Readonly<Record<string, string>>): BannerService {
  const list = createValue<readonly BannerNotice[]>([])
  const recent = new Map<string, number>()
  const dismiss = (id: string): void => {
    list.set(list.current().filter((notice) => notice.id !== id))
  }
  const show: BannerService['show'] = (notice) => {
    const key = notice.detail === undefined ? notice.title : `${notice.title}|\u0000|${notice.detail}`
    const now = Date.now()
    const last = recent.get(key)
    if (last !== undefined && now - last < DEDUPE_MS) return { dispose: () => undefined }
    recent.set(key, now)
    const banner: BannerNotice = {
      ...notice,
      id: createId(),
      holdMs: notice.holdMs ?? DEFAULT_HOLD_MS[notice.severity],
    }
    /* 先记时间再发布：同一条在 3 秒内重复出现时不排队，屏幕上只留当前这条。 */
    list.set([banner])
    return {
      dispose: () => {
        dismiss(banner.id)
      },
    }
  }
  return {
    current: list.current,
    subscribe: list.subscribe,
    show,
    dismiss,
    error(error, title) {
      const described = describeError(error, errorMessages)
      return show({
        severity: 'error',
        title: title ?? described.title,
        detail: title === undefined ? described.detail : `${described.title}：${described.detail}`,
      })
    },
  }
}
