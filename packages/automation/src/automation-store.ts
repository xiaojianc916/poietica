import { warn } from '@poietica/problem'
import { type AutomationDraft, nextRunAfter } from './automation'
import type { AutomationGateway } from './automation-gateway'
import type { Automation, AutomationCatalog, AutomationReschedule, AutomationRun } from './model'

/**
 * 自动化的状态与调度。
 *
 * 落盘走注入的 AutomationGateway：端口是必填参数，组合根忘了注入编译器当场拦下，
 * 不存在「整条落盘链路静默失效」的写法。
 *
 * 屏幕上这份列表是盘上那份的投影，不是与它并行的第二份真相。每一次改动都发一条
 * 按 id 寻址的命令，原生侧串行地读—改—写，再把写完之后的整本目录回给这里；这里
 * 拿它当新的快照。于是没有「先改内存、再补写盘」的窗口，写盘失败时屏幕上也不会
 * 留着一个盘上并不存在的状态。
 *
 * 表不在这里。到期与否由原生侧判定（src-tauri 的 commands/automations.rs），到
 * 期的那一行整条递过来 —— 这里不再拿手上那份可能已经旧了的副本去比时间，也不再养
 * 一个会被平台降频的 setInterval。这一层剩下的只有两件事：把那一行交给 dispatch，
 * 然后把这次运行记上账。
 */

/**
 * 到期时怎么跑。由组合根注入 —— 这一层不认识 agent，也不认识工作台。
 *
 * 返回这次运行开出来的那条对话；开不出来返回 null。
 */
interface AutomationDispatchResult {
  readonly threadId: string | null
  readonly outcome: AutomationRun['outcome']
}

export type AutomationDispatch = (automation: Automation) => Promise<AutomationDispatchResult>

interface AutomationsViewModel {
  readonly automations: readonly Automation[]
  /** 首帧与「读完了但确实一条都没有」不是同一件事，空态因此不会闪。 */
  readonly loaded: boolean
}

export interface AutomationStore {
  readonly getSnapshot: () => AutomationsViewModel
  readonly subscribe: (listener: () => void) => () => void
  /** 成功落盘返回 true；失败时编辑器保留草稿。 */
  readonly create: (draft: AutomationDraft) => Promise<boolean>
  /** 改一条已有的。触发条件没变就不重排下一次运行。 */
  readonly update: (id: string, draft: AutomationDraft) => Promise<boolean>
  readonly remove: (id: string) => void
  readonly setEnabled: (id: string, enabled: boolean) => void
  readonly runNow: (id: string) => void
  /** 启动调度，返回停表函数。与 ThreadsStore.start 同一条纪律。 */
  readonly start: (dispatch: AutomationDispatch) => () => void
}

export function createAutomationStore(gateway: AutomationGateway): AutomationStore {
  let snapshot: AutomationsViewModel = { automations: [], loaded: false }
  const listeners = new Set<() => void>()

  /* 一条自动化同时只有一次运行在飞：慢的那次不会被下一个心跳重复点火。 */
  const inFlight = new Set<string>()
  let dispatch: AutomationDispatch | null = null
  let nextOwner = 0
  let activeOwner: number | null = null

  /*
   * 回程的排序。
   *
   * 原生侧按到达顺序串行写盘，但回程可以乱序抵达：先发的那条后回，它带回来的
   * 就是一份更旧的目录，贴上去屏幕会倒退一格。号码单调递增，只有不比已经贴上
   * 去的那张更旧的号才作数 —— 与浏览器里处理 fetch 竞态的做法同一条规矩。
   */
  let issued = 0
  let applied = 0

  function publish(next: AutomationsViewModel): void {
    snapshot = next

    for (const listener of listeners) {
      listener()
    }
  }

  /** 领一张号，用它接住一次回程。过期的号什么也不做。 */
  function ticket(): (automations: readonly Automation[]) => void {
    issued += 1
    const mine = issued

    return (automations) => {
      if (mine < applied) {
        return
      }

      applied = mine
      publish({ automations, loaded: true })
    }
  }

  /**
   * 发一条写命令，把原生侧回来的那本目录贴到屏幕上。
   *
   * 失败时不动屏幕：这里没有需要回滚的乐观更新，屏幕上仍然是盘上那一份，人看到
   * 的就是这次确实没改成。但不吞掉 —— 交给可观测通道。
   */
  async function command(send: () => Promise<AutomationCatalog>): Promise<boolean> {
    const settle = ticket()

    try {
      const catalog = await send()
      settle(catalog.automations)
      return true
    } catch (cause: unknown) {
      warn('自动化没能写入磁盘，屏幕上仍是磁盘里那一份', {
        scope: 'automations',
        cause,
      })
      return false
    }
  }

  function lookup(id: string): Automation | undefined {
    return snapshot.automations.find((candidate) => candidate.id === id)
  }

  /*
   * 排上还没排的那些。
   *
   * 日历只有一处 —— croner 在这一层求值。账本的其他写者（MCP 工具）只写日程本身，
   * 下一次到期留空，由这里补上再写回。到期与否仍然只看盘上那个时间戳。
   */
  function scheduleMissing(automations: readonly Automation[]): void {
    for (const automation of automations) {
      if (automation.enabled && automation.schedule !== null && automation.nextRunAt === null) {
        void command(() =>
          gateway.upsert({
            ...automation,
            nextRunAt: nextRunAfter(automation.schedule, Date.now()),
          }),
        )
      }
    }
  }

  /**
   * 点一次火。origin 分清是谁点的：日程到点（'schedule'），还是人按了试运行
   * （'manual'）。手动运行不碰日程 —— cron、Temporal 与 Kubernetes 的手动
   * 触发都不改写周期计划，这里同一条规矩。
   */
  async function fire(automation: Automation, origin: 'schedule' | 'manual'): Promise<void> {
    /*
     * 先快照，再用。两个理由，缺一个都会出事：
     *
     *   1. dispatch 是模块作用域里可变的 AutomationDispatch | null。只有快照成
     *      const，null 检查之后的收窄才活得过下面那个 await —— 直接判 dispatch
     *      再 await dispatch(...)，收窄会在 await 处失效。
     *   2. start() 返回的停表函数会把 dispatch 置回 null。分两次读，就可能一次
     *      非空、一次为空。
     *
     * 名字叫 invoke 不叫 run：run 归 AutomationRun —— 那是这个领域里的名词，
     * 不该被一个装着函数的局部变量占着。
     */
    const invoke = dispatch

    if (invoke === null || inFlight.has(automation.id)) {
      return
    }

    inFlight.add(automation.id)

    const startedAt = new Date().toISOString()
    let result: AutomationDispatchResult = { threadId: null, outcome: 'failed' }

    try {
      result = await invoke(automation)
    } catch (cause: unknown) {
      warn('自动化这次没有跑起来', { scope: 'automations', cause })
    } finally {
      inFlight.delete(automation.id)
    }

    /* 运行结果只由 agent turn 的终帧决定；thread 创建不是成功。 */
    const run: AutomationRun = {
      threadId: result.threadId,
      startedAt,
      outcome: result.outcome,
    }

    /*
     * from 只用来比对，不参与算下一次：cron 表达式自己就是相位，下一次落在哪里
     * 与这一次跑了多久无关。
     *
     * 「运行期间日程有没有被人动过」这一问不在这里回答：这里手上只有一份可能已经
     * 过时的副本，拿副本比副本等于没比。from 送过去，由持有真相的那一侧比对。
     */
    const anchor = automation.nextRunAt
    const reschedule: AutomationReschedule =
      origin === 'schedule' && anchor !== null
        ? {
            kind: 'advance',
            from: anchor,
            to: nextRunAfter(automation.schedule, Date.now()),
          }
        : { kind: 'keep' }

    void command(() => gateway.recordRun({ id: automation.id, run, reschedule }))
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },

    create(draft) {
      return command(() =>
        gateway.create({
          title: draft.title,
          prompt: draft.prompt,
          schedule: draft.schedule,
          sessionConfig: { ...draft.sessionConfig },
          nextRunAt: nextRunAfter(draft.schedule, Date.now()),
        }),
      )
    },

    update(id, draft) {
      const current = lookup(id)

      if (current === undefined) {
        return Promise.resolve(false)
      }

      return command(() =>
        gateway.upsert({
          ...current,
          title: draft.title,
          prompt: draft.prompt,
          schedule: draft.schedule,
          sessionConfig: { ...draft.sessionConfig },

          /*
           * 只有日程真的变了才重排。否则改一个错别字，下一次运行就被推走 ——
           * 人动的是提示词，不是日程。表达式是一段文字，比一次相等就够了。
           *
           * 停用状态下 nextRunAt 本来就是 null（见 setEnabled），照原样留着即可。
           */
          nextRunAt:
            current.enabled && current.schedule !== draft.schedule
              ? nextRunAfter(draft.schedule, Date.now())
              : current.nextRunAt,
        }),
      )
    },

    remove(id) {
      void command(() => gateway.remove(id))
    },

    setEnabled(id, enabled) {
      const current = lookup(id)

      if (current === undefined) {
        return
      }

      /*
       * 重新启用时下一次到期从此刻重新起算，不是接着那个早已过期的时刻 ——
       * 否则一停一开，人立刻挨一次补跑，那不是他按下开关时想要的。
       */
      void command(() =>
        gateway.upsert({
          ...current,
          enabled,
          nextRunAt: enabled ? nextRunAfter(current.schedule, Date.now()) : null,
        }),
      )
    },

    runNow(id) {
      const automation = lookup(id)

      if (automation !== undefined) {
        void fire(automation, 'manual')
      }
    },

    start(next) {
      if (activeOwner !== null) {
        throw new Error('AutomationStore is already started.')
      }

      nextOwner += 1
      const owner = nextOwner
      activeOwner = owner
      dispatch = next

      const settle = ticket()

      /*
       * 这一次读取只为画列表，与「什么时候跑」无关：到期的那一行由原生侧递过来，
       * 不从这份快照里查。所以读失败只是列表空着，日程照走。
       */
      void gateway
        .loadCatalog()
        .then((catalog) => {
          if (stopped) {
            return
          }

          settle(catalog.automations)
          scheduleMissing(catalog.automations)
        })
        .catch((cause: unknown) => {
          if (stopped) {
            return
          }

          warn('自动化列表读取失败', { scope: 'automations', cause })
          settle([])
        })

      const offs: Array<() => void> = []
      let stopped = false

      /* 兑现可能落在清理之后：就地摘表，别留一个悬空的监听。 */
      const hold = (off: () => void): void => {
        if (stopped) {
          off()

          return
        }

        offs.push(off)
      }

      void gateway
        .watchDue((automation) => {
          if (!stopped) {
            void fire(automation, 'schedule')
          }
        })
        .then(hold)
        .catch((cause: unknown) => {
          warn('自动化调度没能启动', { scope: 'automations', cause })
        })

      /* 账本的写者不只有这里：原生侧写完就宣布，屏幕与日历跟着走。 */
      void gateway
        .watchCatalog((catalog) => {
          if (stopped) {
            return
          }

          const settled = ticket()

          settled(catalog.automations)
          scheduleMissing(catalog.automations)
        })
        .then(hold)
        .catch((cause: unknown) => {
          warn('自动化账本的变更没能盯上', { scope: 'automations', cause })
        })

      return () => {
        if (activeOwner !== owner) {
          return
        }

        activeOwner = null
        stopped = true

        for (const off of offs) {
          off()
        }

        offs.length = 0
        dispatch = null
      }
    },
  }
}
