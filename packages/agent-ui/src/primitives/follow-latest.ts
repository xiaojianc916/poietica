import { useReducedMotion } from 'motion/react'
import { useCallback, useRef, useSyncExternalStore } from 'react'

/**
 * 距末端多近算作「回到了最新」。
 *
 * 它回答两件事：跟随要不要重新上闩，以及那枚「回到最新」的按钮该不该在。它不回答「人走开
 * 了没有」——那由方向回答，见 nextFollow。约等于一格滚轮，所以人滚回底部附近就重新接管，
 * 不必压到零。
 */
const NEAR_END_PX = 48

/**
 * 一段返回位移走多久。
 *
 * 固定值，与要走的距离无关，所以一段很长的对话与一段很短的对话回到末端的手感是同一个 ——
 * 这是「回到最新」这个动作该有的性质：它不是在遍历历史，是在换一个落点。
 *
 * 量级取自仓库里最近的同类数字 --cp-motion-settle（320ms）。没有直接吃那个令牌：它是 CSS
 * 自定义属性，从这里拿它要 getComputedStyle 再解析字符串，还会把这个 hook 拴到皮肤层上，
 * 而这个数字描述的是滚动位置的行为，不是外观。
 */
const TRAVEL_MS = 360

/**
 * 人主动改变一段内容高度的标准声明。
 *
 * aria-expanded 是 WAI-ARIA 给「这个控件控制一段可展开区域」的属性，封条与抽屉的开关全都
 * 带着它（timeline/turn-seal.tsx、primitives/disclosure.tsx）。拿它当判据，比去嗅探活动
 * 动画表可靠：意图来自那一次点击，不来自动画的副作用，减弱动态偏好把过渡关掉时它照样成立。
 */
const DISCLOSURE = '[aria-expanded]'

/** 一次滚动几何读数。字段名与 Element 对齐，所以可以直接从元素上抄。 */
export interface ScrollGeometry {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}

/** 一次读三个量。分三次读会读到三帧之间的布局，而这三个数必须互相自洽。 */
function seen(element: HTMLElement): ScrollGeometry {
  return {
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }
}

/**
 * 末端还剩多远。
 *
 * 这是 DOM 的真值：三个量来自同一个盒子，所以内边距、尾部预留、以及未测量内容的估高误差
 * 全都含在里面。虚拟窗口的推算值做不到 —— 它的总高是内层定高盒子的高度，既不含盒子自己的
 * 内边距，也在声明了 scrollMargin 时把那一段减掉却不加回。
 *
 * 不夹到 0：橡皮筋滚动会让它变成负数，而负数与 0 对下面那条判据是同一个答案，夹一次只会
 * 掩盖一个真实状态。
 */
export function distanceFromEnd(geometry: ScrollGeometry): number {
  return geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop
}

/** 这个几何算不算「视口在末端」。 */
export function staysWithLatest(geometry: ScrollGeometry): boolean {
  return distanceFromEnd(geometry) <= NEAR_END_PX
}

/**
 * 位移的曲线：三次缓出。
 *
 * 前段快、末段慢。匀速读起来像机器在拖，而缓出读起来是「被拽了一把然后放手」—— 这是位移
 * 类过渡的通行形状，也是这个界面上其它过渡的形状（--ui-ease-standard 一族同样是减速为主）。
 */
export function easeOut(fraction: number): number {
  const remaining = 1 - fraction

  return 1 - remaining * remaining * remaining
}

/**
 * 位移在某一时刻该落在哪；返回 null 表示这一段走完了。
 *
 * 目标每一次都从传进来的几何重算，而不是在开始时算一次记住：虚拟列表的总高是估出来的，行
 * 被真实测量后它会改，内容边写边长时它也在改。捕获一次目标的做法（平台的平滑滚动就是这么
 * 做的）会在半路把终点定死在一个已经不存在的位置上。
 *
 * 两个终止条件都不依赖运气：时间到，或者末端跑到了当前位置的后面（内容缩短时会发生）。
 *
 * 取 max 是为了单调：目标缩短会让算出的位置回到当前位置之上，而位移途中任何一次向上写入
 * 都是可见的抽动。宁可写一个没有位移的值（浏览器不会为它派发滚动），也不往上顶。
 */
export function travelStep(
  origin: number,
  geometry: ScrollGeometry,
  fraction: number,
): number | null {
  if (fraction >= 1) {
    return null
  }

  const target = geometry.scrollHeight - geometry.clientHeight

  if (target <= geometry.scrollTop) {
    return null
  }

  return Math.max(origin + (target - origin) * easeOut(fraction), geometry.scrollTop)
}

/**
 * 跟随的状态。两位，各回答一个问题。
 *
 * follows：内容长高时要不要把视口带走。
 * traveling：此刻有没有一段返回位移正在进行 —— 有的话，贴合必须整段让路。
 */
export interface FollowState {
  readonly follows: boolean
  readonly traveling: boolean
}

const AT_LATEST: FollowState = { follows: true, traveling: false }
const LET_GO: FollowState = { follows: false, traveling: false }
const TRAVELING: FollowState = { follows: true, traveling: true }

/**
 * 一次滚动之后的下一状态。四个入参就是全部判据，所以它是纯函数，能脱离 DOM 钉住。
 *
 * 判「人走开了没有」只能看方向，不能看距离。距离判据在带动画的滚轮下必然失效：Chromium
 * 把一格滚轮拆成十几个几像素的增量事件，第一个增量离末端还不到十个像素 —— 于是「还在末端」
 * 成立，跟随不放手，下一次提交又把视口拨回末端，人就被粘在底部。这也是标杆的做法：
 * use-stick-to-bottom（Vercel AI Elements 的 Conversation 用的就是它）判的是方向加「是不是
 * 自己写的」，距离只用来重新上闩。
 *
 * 但方向本身不够：内容变短时浏览器会把 scrollTop 夹小，这在事件层与人往上拨一模一样，而
 * 它是折叠或重测引起的，不是手势。所以方向要减去「这一次夹紧最多能推多少」，算法与理由
 * 写在下面那两行旁边。
 *
 * 位移途中不看距离：进了近末端那一带也不收状态。收过一版，结果是两个写者同时存在，落底前
 * 会被往上顶一下。位移只由持有它的那个循环终止，或者由人往上拨终止。
 */
export function nextFollow(
  before: ScrollGeometry,
  after: ScrollGeometry,
  now: FollowState,
  ours: boolean,
): FollowState {
  /* 自己那一笔瞬时贴合必然写到末端，而位移期间不会有那一笔。 */
  if (ours) {
    return AT_LATEST
  }

  /*
   * 一次夹紧最多能把 scrollTop 往上推多少。
   *
   * 可滚动范围的上界是 scrollHeight - clientHeight。内容变短、或者视口变高，这个上界就
   * 下移，浏览器随即把越界的 scrollTop 夹回来 —— 那一下在事件层与人往上拨一模一样，这
   * 正是原来那个 shrank 项要挡的东西。
   *
   * 但夹紧是有界的：它至多把 scrollTop 推到新的上界，也就是至多推这么多。超出这个额度
   * 的位移，没有任何被动机制能产生，只可能是人。所以判据从「有没有变短」换成「走得比变
   * 短的多不多」—— 后者是前者的严格推广：什么都没变短时额度是 0，条件退化成 moved > 0，
   * 与原来的 wentUp 逐位相同。改动面因此精确地只有一种情形，而那一种正是坏掉的那一种。
   *
   * 这一项是承重的。工具行的估高与真高差着数倍（见 agent-activity-feed 的
   * ESTIMATED_ROW_PX），人往上滚时每挂载一行就被真高替换一次，总高连着往下掉；原来的
   * shrank 项于是一路否决放手，而变短同时把「离末端多远」压进近末端那一带，跟随重新成立，
   * 下一次提交把人拨回底部 —— 人就粘在最底下滚不上去。
   */
  const moved = before.scrollTop - after.scrollTop
  const slack = Math.max(
    0,
    before.scrollHeight - after.scrollHeight + (after.clientHeight - before.clientHeight),
  )

  /* 位移途中同样成立，而且这就是位移的取消路径。 */
  if (moved > slack) {
    return LET_GO
  }

  /*
   * 一次补偿最多能把 scrollTop 往下推多少。slack 的镜像。
   *
   * 内容变长、或者视口变矮，可滚动上界上移，而虚拟器会为「视口上方那些刚被真高替换的
   * 行」补一次向下的滚动，好让人眼前那一行别跑掉 —— 它至多补这么多。
   */
  const lift = Math.max(
    0,
    after.scrollHeight - before.scrollHeight + (before.clientHeight - after.clientHeight),
  )

  /*
   * 这一次位移被动机制全额解释得了 —— 它不携带任何人的意图。
   *
   * 两个方向都要挡，而此前只挡了向上那一边：向上是浏览器夹紧（内容变短），向下是虚拟器
   * 补偿（内容变长）。两者都不是手势，可当时只写了 moved > 0。
   *
   * 漏掉向下那一边的代价，正是「在末端点开封条就抽」：onToggle 刚把状态设成 LET_GO，摊开
   * 让内容一下子长出几十行，虚拟器逐行把估高换成真高并向下补偿 —— 那一下 moved 是负的，
   * 从向上那条判据底下穿过去，落到最后一行 staysWithLatest。视口确实还在末端附近，于是跟随
   * 重新上闩，LET_GO 被一次根本不是人做的滚动当场撤销；下一次提交 settle 看见内容长高了，
   * 就把人拨到底。而行还在一批批挂载、一行行重测，于是上闩、贴合、重测、再上闩。
   *
   * 判据写成一句：位移落在 [-lift, slack] 这段被动区间里就没有信息。区间外才是人 —— 上面
   * 那条 moved > slack 已经接走向上越界的一侧，这里接住其余全部。什么都没变时区间塌成一个
   * 点，条件退化成 moved === 0，与「压根没动过」逐位相同。
   *
   * 交回 now 而不是某个常量：没有信息就不该改变任何一位 —— 本来在跟的继续跟，本来让开的
   * 继续让开，位移途中的继续走。区间之内两种归因都是编，而不归因不是。
   */
  if (moved >= -lift) {
    return now
  }

  if (now.traveling) {
    return TRAVELING
  }

  return { follows: staysWithLatest(after), traveling: false }
}

/** 末端跟随交出来的东西，各有明确的调用点。 */
export interface FollowLatest {
  /** 视口此刻是否在末端。几何，不是意图 —— 它只喂「回到最新」那枚按钮的存在。 */
  readonly atLatest: boolean
  /** 若人还跟着最新内容，把视口瞬时拨到末端；无论跟不跟，都重新发布一次几何。 */
  readonly stick: () => void
  /** 人接管了滚动位置。粘滞，由「人自己滚回末端」解除。 */
  readonly release: () => void
  /** 重新跟上，并瞬时拨到末端。给「打开一个小盒子」这类没有距离的返回。 */
  readonly resume: () => void
  /** 重新跟上，并带着一段看得见的位移回到末端。给人亲手要求的那一次返回。 */
  readonly travel: () => void
  readonly watch: (viewport: HTMLElement) => () => void
}

/**
 * 滚动位置在末端这一侧的唯一所有者。
 *
 * 滚动位置归盒子的主人。这条规则没有例外：会话流的滚动区归 AgentActivityFeed，思考链那个
 * 有上限的盒子归 ReasoningPanel，工具载荷那个 tabpanel 归 ToolCallPanels —— 谁挂的元素，谁
 * 决定它跟不跟最新内容走。铺内容的那一层（虚拟窗口）因此一个 scrollTop 都不写：它不知道
 * 自己被装在什么盒子里，也就没有资格替那个盒子做这个决定。
 *
 * 「贴住最新内容」不外包给虚拟器的 anchorTo 'end' 与 followOnAppend。那套原语覆盖不到这个
 * 界面最活跃的东西，而这不是配置没调好，是它的坐标系里没有那些东西：
 *
 *   - 瞬态过程区与等待指示器坐在 paddingEnd 里。paddingEnd 是一个数字而不是条目，它变大既
 *     不经过 resizeItem（那个只由带 data-index 的节点触发），也不满足追加判据。
 *   - 「贴没贴底」在库内部有两个不同源的定义：resizeItem 读推算距离，追加那道门读 DOM 真值。
 *   - 增量补偿写在 ResizeObserver 回调里，而长高要等 React 提交才落到 DOM，那次写入会被
 *     浏览器夹掉；库把意图记在自己的偏移量里，DOM 从此落后一截。这条是库源码自己的注释。
 *   - 它不受调用方的策略约束：一个声明了「不要追末端」的盒子，仍会在内容追加时被拨到末行。
 *
 * 落位有两种方式，而不是一种。
 *
 * 持续跟随不补间：流式输出每帧长几十像素，动画追一个还在往下跑的目标永远追不上，视口会一直
 * 落在真末端后面一截，纸面读起来是自己在往上爬。所以 stick 写 scrollTop，瞬时。
 *
 * 人亲手要求的那一次返回必须补间：那是一段有距离的位移，闪现会把「我刚才在哪」抹掉。这一段
 * 由这里自己持有一个 rAF 循环走完，不用 scrollTo 的 smooth —— 那个原语在这个场景下三条都不
 * 成立：时长与曲线由 UA 定、没有接口；它在开始时捕获一次目标，而虚拟列表的目标每帧都在动；
 * 它的完成事件同样会被程序化的瞬时写入触发，于是位移的收尾会被自己的启动动作提前放行。标杆
 * 也是自己写循环并每帧重读目标（use-stick-to-bottom），理由就是内容会在途中长高。
 *
 * 自己持有循环唯一要还的债是取消，而这笔债由规范抵掉：HTML 的 update the rendering 把滚动
 * 事件的派发排在 rAF 回调之前，所以人在第 N 帧拨了滚轮，第 N 帧的滚动事件先到、方向判据当场
 * 放手，同一帧稍后的循环回调看见状态已变就直接不写。取消是一帧内精确的，不需要额外去监听
 * 任何输入事件。
 *
 * 两种方式共存的代价是 traveling 这一位：位移进行时贴合整段让路，一次瞬时写入会当场把它掐掉。
 *
 * 减弱动态偏好下位移退化成瞬时贴合，问的是 motion 的 useReducedMotion —— 与 live-process
 * 同一个来源，这个界面上「要不要少一些动效」只有一个答案。
 *
 * 状态各自只有一个存储位置：意图与位移（FollowState）、上一次读到的几何、几何（在不在末端）。
 * 前两者不参与渲染，所以是 ref；末一个要画那枚按钮，所以它经 useSyncExternalStore 发布 ——
 * 那是 React 给「外部可变值参与渲染」的官方接口，一处存储加一条通知。
 */
export function useFollowLatest(): FollowLatest {
  const viewport = useRef<HTMLElement | null>(null)
  const reduced = useReducedMotion()

  /* 开场就跟着：一个盒子刚挂上时该看见最新内容，这是唯一一次不需要任何人下令的跟随。 */
  const state = useRef<FollowState>(AT_LATEST)

  /*
   * 自己写的那一笔瞬时贴合。
   *
   * 只在写入真的改变了值时才立起来：值没变浏览器不派发滚动事件，标记会一直挂着，然后吞掉人
   * 下一次向上滚。位移循环的每帧写入不立这个标记 —— 立了会让判据把位移当成「贴合刚做完」，
   * 当场收掉状态。
   */
  const ours = useRef(false)

  /*
   * 开场那一次贴合做过没有。
   *
   * 只立一次，之后永远为真。settle 的长高闸拿它区分「高度从无到有」与「什么都没长」——
   * 前者要拨，后者不该拨。此前这件事是无闸 stick 的副产品，加了闸就得把它说出来。
   */
  const primed = useRef(false)

  const last = useRef<ScrollGeometry>({ clientHeight: 0, scrollHeight: 0, scrollTop: 0 })
  const travelFrame = useRef<number | null>(null)

  const atLatest = useRef(true)
  const listeners = useRef(new Set<() => void>())

  const subscribe = useCallback((onChange: () => void) => {
    listeners.current.add(onChange)

    return () => {
      listeners.current.delete(onChange)
    }
  }, [])

  const snapshot = useCallback(() => atLatest.current, [])

  const publish = useCallback((next: boolean) => {
    if (atLatest.current === next) {
      return
    }

    atLatest.current = next

    for (const notify of listeners.current) {
      notify()
    }
  }, [])

  const stopTravel = useCallback(() => {
    if (travelFrame.current !== null) {
      cancelAnimationFrame(travelFrame.current)
      travelFrame.current = null
    }
  }, [])

  /*
   * 拨一次末端，然后重新发布几何。
   *
   * forced 回答的是「这一次为什么要拨」，而不是所有调用点都有内容要跟：
   *
   *   false —— 每一次提交、每一次尺寸变化。这两处问的是「内容也许长高了」，所以只有真
   *     的长高了才写。没长高还写，就是把人从近末端硬拽到末端。
   *   true —— 人亲手要求回到末端（resume 与 travel 的落位）。那时高度往往一动不动，而
   *     拨过去正是这次调用的全部目的。
   *
   * 这道闸是有出处的：调用它的那个布局效应在 agent-activity-feed 里写着「写的值与当前值
   * 相同时浏览器连事件都不派发，所以每次提交都跑的代价就是一次赋值」。那句话只在人正好
   * 压在末端时成立。NEAR_END_PX 那一带里 follows 为真而视口不在末端，同一句赋值于是变成
   * 一次至多 48 像素的瞬时位移 —— 人把滚动条拖到接近底部松手，就被吸了下去。
   *
   * 阈值本身不动：它同时回答「那枚按钮该不该在」，而按钮要的正是这份宽容。要改的是把
   * 「下次长高时跟着走」读成「现在就贴过去」的这一层，不是那个数。
   */
  const settle = useCallback(
    (forced: boolean) => {
      const element = viewport.current

      if (element === null) {
        return
      }

      if (state.current.follows && !state.current.traveling) {
        /* 开场那一次没有「上一次」可比：高度是从无到有的，不是长高。 */
        const grew = !primed.current || element.scrollHeight > last.current.scrollHeight

        primed.current = true

        if (forced || grew) {
          const before = element.scrollTop

          /*
           * 写一个必然越界的值，让浏览器去夹。
           *
           * CSSOM View 规定 scrollTop 的 setter 把值夹进可滚动范围，所以这一句就是「拨到
           * 末端」的全文。它是瞬时的，因为滚动区的 scroll-behavior 是 auto —— setter 用的
           * 是那个计算值。那句声明因此是承重的：改成 smooth 会让持续跟随和位移循环的每帧
           * 写入全都变成动画。
           */
          element.scrollTop = element.scrollHeight

          if (element.scrollTop !== before) {
            ours.current = true
          }
        }
      }

      const geometry = seen(element)

      last.current = geometry
      publish(staysWithLatest(geometry))
    },
    [publish],
  )

  const stick = useCallback(() => {
    settle(false)
  }, [settle])

  const release = useCallback(() => {
    state.current = LET_GO
  }, [])

  /*
   * 重新跟上要连着拨一次，不能只举旗。
   *
   * 举旗的效果要等下一次高度变化才看得见，而重新跟上的那些时机恰恰不伴随高度变化：一段边写
   * 边看的内容被重新展开、一个小盒子刚打开。所以这里自己拨一次，把「跟上」与「到末端」合成
   * 同一帧。
   */
  const resume = useCallback(() => {
    state.current = AT_LATEST
    settle(true)
  }, [settle])

  const travel = useCallback(() => {
    const element = viewport.current

    if (element === null) {
      return
    }

    /* 连点两次不该跑出两个循环互相写。 */
    stopTravel()

    const geometry = seen(element)

    /* 没有距离可走，或者这个人要求少一些动效：直接贴合。一段看不见的动画不值得一个状态。 */
    if (reduced === true || staysWithLatest(geometry)) {
      state.current = AT_LATEST
      settle(true)

      return
    }

    state.current = TRAVELING

    const origin = geometry.scrollTop

    /* rAF 回调的时间戳与 performance.now() 同一个时间原点，所以这两个数可以直接相减。 */
    const startedAt = performance.now()

    const step = (time: number) => {
      travelFrame.current = null

      const box = viewport.current

      /* 有人接手了滚动位置，或者盒子已经拆了：一步都不写。 */
      if (box === null || !state.current.traveling) {
        return
      }

      const next = travelStep(origin, seen(box), (time - startedAt) / TRAVEL_MS)

      if (next === null) {
        state.current = AT_LATEST
        settle(true)

        return
      }

      box.scrollTop = next
      travelFrame.current = requestAnimationFrame(step)
    }

    travelFrame.current = requestAnimationFrame(step)
  }, [reduced, settle, stopTravel])

  const watch = useCallback(
    (element: HTMLElement) => {
      viewport.current = element
      last.current = seen(element)
      publish(staysWithLatest(last.current))

      const onScroll = () => {
        const geometry = seen(element)

        state.current = nextFollow(last.current, geometry, state.current, ours.current)
        ours.current = false
        last.current = geometry
        publish(staysWithLatest(geometry))
      }

      /*
       * 人亲手展开或收起一段内容时，末端不再是家。
       *
       * 没有这一条，读者在末端点开封条会被立刻拨回末端 —— 而他要看的东西在上面。委托在滚动
       * 区上，所以封条、思考链、工具卡片一并覆盖，不需要谁来登记。
       */
      const onToggle = (event: Event) => {
        const target = event.target

        if (target instanceof Element && target.closest(DISCLOSURE) !== null) {
          state.current = LET_GO
        }
      }

      element.addEventListener('scroll', onScroll, { passive: true })
      element.addEventListener('click', onToggle)

      return () => {
        stopTravel()
        element.removeEventListener('scroll', onScroll)
        element.removeEventListener('click', onToggle)
        viewport.current = null
      }
    },
    [publish, stopTravel],
  )

  return {
    atLatest: useSyncExternalStore(subscribe, snapshot),
    release,
    resume,
    stick,
    travel,
    watch,
  }
}
