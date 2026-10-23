import { WAVE, type WaveOptions } from './wave-plan'
import { WAVE_MARKER_ATTRIBUTE, WAVE_START_ATTRIBUTE } from './wave-reveal'

const KEYFRAMES: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }]
const MARKER_KEYFRAMES: Keyframe[] = [{ color: 'transparent' }, {}]
const EASING = 'cubic-bezier(0.33, 0, 0.2, 1)'
const SELECTOR = `[${WAVE_START_ATTRIBUTE}],[${WAVE_MARKER_ATTRIBUTE}]`

/** animation 为 null = 这个元素被判「直接实显」 */
interface Pinned {
  animation: Animation | null
  start: number
}
const body = new WeakMap<Element, Pinned>()
const marker = new WeakMap<Element, Pinned>()

interface Fresh {
  readonly el: Element
  readonly start: number
  readonly map: WeakMap<Element, Pinned>
  readonly isMarker: boolean
}

/**
 * 提交之后、绘制之前调用（useLayoutEffect）。只扫本段正文的子树，按文档顺序。
 * 每个动画的 startTime 钉在小段的绝对启动时刻：节点被 React 复用给另一段、或被挪动，
 * 进度立即对上，不重播、不截断。
 *
 * 全量扫描：子树里有多少标记就查多少个。流式中每帧都调用时用 createWaveSync，只查本次提交变了的节点。
 */
export function syncWave(host: Element, options: WaveOptions = WAVE): void {
  pin(host.querySelectorAll(SELECTOR), options)
}

export interface WaveSync {
  /** 给自上次 sync 以来新增或改了标记的元素挂淡入；返回这次检查了多少个候选（测试用来钉住「只查增量」） */
  sync(): number
  dispose(): void
}

/**
 * syncWave 的增量版。被 Streamdown memo 住的旧块不再重渲，但它们的标记要到流式结束才摘 ——
 * 每帧全量 querySelectorAll 的成本随回复长度线性涨，整段回复就是 O(n²)，长回复后半段每帧多出几毫秒。
 * 这里用 MutationObserver 只收本次提交新插入的子树和改了标记的元素；判定规则与 syncWave 完全相同
 * （同一对 WeakMap、同样按文档顺序截取最后 maxFreshPerCommit 个），所以结果一致，只是不再重看旧块。
 * 第一次 sync 做一遍全量：观察器建立之前就在 DOM 里的标记也要被看到。
 */
export function createWaveSync(host: Element, options: WaveOptions = WAVE): WaveSync {
  /* 不经 React 提交的 DOM 变动会在微任务里送到回调：先攒着，下一次 sync 一并处理，不能丢 */
  const pending: MutationRecord[] = []
  const observer = new MutationObserver((records) => {
    pending.push(...records)
  })
  observer.observe(host, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [WAVE_START_ATTRIBUTE, WAVE_MARKER_ATTRIBUTE],
  })
  let primed = false
  return {
    sync() {
      const records = pending.splice(0).concat(observer.takeRecords())
      if (!primed) {
        primed = true
        const all = host.querySelectorAll(SELECTOR)
        pin(all, options)
        return all.length
      }
      const changed = changedMarkers(host, records)
      pin(changed, options)
      return changed.length
    },
    dispose() {
      observer.disconnect()
      pending.length = 0
    },
  }
}

/** 本批变动里仍在 host 下、带标记的元素，按文档顺序、去重 */
function changedMarkers(host: Element, records: readonly MutationRecord[]): Element[] {
  const found = new Set<Element>()
  const consider = (el: Element) => {
    if (el.matches(SELECTOR)) found.add(el)
  }
  for (const record of records) {
    if (record.type === 'attributes') {
      if (record.target instanceof Element) consider(record.target)
      continue
    }
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue
      consider(node)
      for (const el of node.querySelectorAll(SELECTOR)) found.add(el)
    }
  }
  /* 先插入后又被删掉的节点不再算；插入顺序不保证是文档顺序，截取「最后 N 个」前要排好 */
  return [...found].filter((el) => host.contains(el)).sort(byDocumentOrder)
}

function byDocumentOrder(a: Element, b: Element): number {
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
}

function pin(candidates: Iterable<Element>, options: WaveOptions): void {
  const fresh: Fresh[] = []
  const visit = (el: Element, attribute: string, map: WeakMap<Element, Pinned>, isMarker: boolean) => {
    const raw = el.getAttribute(attribute)
    if (raw === null) return
    const start = Number(raw)
    const pinned = map.get(el)
    if (pinned !== undefined && pinned.start === start) return
    if (pinned?.animation) {
      pinned.animation.startTime = start
      pinned.start = start
      return
    }
    fresh.push({ el, start, map, isMarker })
  }
  for (const el of candidates) {
    visit(el, WAVE_MARKER_ATTRIBUTE, marker, true)
    visit(el, WAVE_START_ATTRIBUTE, body, false)
  }
  /* 一次来得太多（从后台切回、长时间卡顿后）：只让最后 maxFreshPerCommit 个淡入 */
  const skip = Math.max(0, fresh.length - options.maxFreshPerCommit)
  fresh.forEach(({ el, start, map, isMarker }, index) => {
    if (index < skip) {
      map.set(el, { animation: null, start })
      return
    }
    map.set(el, { animation: waveFadeIn(el, start, options, isMarker), start })
  })
}

/**
 * 给一段新字挂淡入，startTime 钉在它的绝对启动时刻：回复正文（syncWave）与思考行（ticker-engine）共用这一条 ——
 * 同一套关键帧、时长与曲线，两处的「新字出现」是同一个样子。
 */
export function waveFadeIn(el: Element, start: number, options: WaveOptions = WAVE, isMarker = false): Animation {
  const timing: KeyframeAnimationOptions = { duration: options.fadeMs, easing: EASING, fill: 'backwards' }
  const animation = isMarker
    ? el.animate(MARKER_KEYFRAMES, { ...timing, pseudoElement: '::marker' })
    : el.animate(KEYFRAMES, timing)
  animation.startTime = start
  return animation
}
