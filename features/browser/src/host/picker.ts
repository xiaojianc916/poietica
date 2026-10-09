import { randomUUID } from 'node:crypto'
import { PICKER_CALLBACK_HOST } from '../contract/entities'

/*
 * 元素拾取的宿主侧（07 页 §12D）。**迁移自** legacy `apps/desktop/electron/browser/element-picker.ts`，
 * 只换 token 的口径与回调形状：
 *   - legacy 的 token 是自增整数，正本在 crates/browser/src/picker.rs；
 *   - 新架构里页面脚本与宿主之间只有一条回调地址，token 换成 `crypto.randomUUID()`
 *     （07 页 §12D 第 1 条），页面主世界猜不到。
 *
 * 租约语义照旧：一次拾取只租给一个标签一个 token，回调必须带着当前租约才算数 ——
 * 页面上的旧面板晚一步回话时，那份载荷已经属于上一次拾取，收下就会把别人的元素塞进这一轮。
 */

const ELEMENT_TYPE_LIMIT = 64
const COMMENT_LIMIT = 2_000
/** 快照经查询串回来，上界只为挡住失控的页面，不是内容策略。 */
const REPORT_LIMIT = 64_000

/** 取消注入脚本：与 legacy 同一条，宿主随时可以叫停页面上的拾取。 */
export const PICKER_CANCEL_SCRIPT = 'window.__poieticaElementPicker?.cancel();'

export interface PickerLease {
  readonly tabId: number
  readonly token: string
}

export interface PickedElement {
  readonly elementType: string
  readonly comment: string
  readonly report: string
}

export type PickOutcome =
  | { readonly kind: 'cancelled'; readonly token: string }
  | {
      readonly kind: 'submitted'
      readonly token: string
      readonly submission: 'attach' | 'send'
      readonly element: PickedElement
    }

export interface Picker {
  activeTabId(): number | null
  start(tabId: number): PickerLease
  cancel(tabId: number): PickerLease | null
  cancelActive(): PickerLease | null
  finish(tabId: number, token: string): boolean
}

/** 租约只活在内存里：它是「此刻谁在拾取」，进程重启后没有任何意义。 */
export function createPicker(newToken: () => string = randomUUID): Picker {
  let active: PickerLease | null = null

  return {
    activeTabId: () => active?.tabId ?? null,

    start(tabId) {
      active = { tabId, token: newToken() }

      return active
    },

    cancel(tabId) {
      if (active?.tabId !== tabId) {
        return null
      }

      const lease = active

      active = null

      return lease
    },

    cancelActive() {
      const lease = active

      active = null

      return lease
    },

    finish(tabId, token) {
      if (active?.tabId !== tabId || active.token !== token) {
        return false
      }

      active = null

      return true
    },
  }
}

function clamp(value: string, limit: number): string {
  return [...value].slice(0, limit).join('')
}

/** 标签只进输入框 chip；压成单行并限制长度。 */
function oneLine(value: string): string {
  return clamp(
    value
      .split(/\s+/u)
      .filter((part) => part.length > 0)
      .join(' '),
    ELEMENT_TYPE_LIMIT,
  )
}

export function isPickerCallback(url: string): boolean {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  return parsed.protocol === 'https:' && parsed.hostname === PICKER_CALLBACK_HOST && parsed.pathname === '/'
}

/** 认不出的回调一律返回 null：宁可当它没发生，也不收半份载荷。 */
export function decodePickerCallback(url: string): PickOutcome | null {
  if (!isPickerCallback(url)) {
    return null
  }

  const params = new URL(url).searchParams
  const token = params.get('token')
  const kind = params.get('kind')

  if (token === null || token.length === 0) {
    return null
  }

  /* kind=cancelled 是 07 页 §12D 第 3 条的写法；submission=cancel 是 legacy 面板的旧写法。 */
  if (kind === 'cancelled' || kind === 'cancel' || params.get('submission') === 'cancel') {
    return { kind: 'cancelled', token }
  }

  if (kind !== null && kind !== 'submitted') {
    return null
  }

  const submission = params.get('submission')

  if (submission !== 'attach' && submission !== 'send') {
    return null
  }

  const elementType = oneLine(params.get('elementType') ?? '')
  const report = clamp(params.get('report') ?? '', REPORT_LIMIT)

  // 没有元素类型或没有快照的提交是半份载荷：picker.rs 同样拒收。
  if (elementType.length === 0 || report.length === 0) {
    return null
  }

  return {
    kind: 'submitted',
    token,
    submission,
    element: {
      elementType,
      comment: clamp(params.get('comment') ?? '', COMMENT_LIMIT),
      report,
    },
  }
}
