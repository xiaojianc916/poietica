import type { OpenedThread, ThreadPort, ThreadRecord } from '@poietica/agent-contract'
import { describeFailure } from './describe-failure'
import { withEntry, withoutEntry } from './immutable-map'
import type { ThreadsList } from './thread-order'
import { NO_ITEMS, ThreadProjection } from './thread-projection'
import { nameOf, shorten } from './thread-title'

interface Held {
  readonly threads: readonly ThreadRecord[]
  readonly pending: readonly ThreadRecord[]
  readonly provisional: ReadonlyMap<string, string>
  readonly isLoading: boolean
  readonly failure: string | null
}

const NO_PROVISIONAL: ReadonlyMap<string, string> = new Map()

const EMPTY: Held = {
  threads: [],
  pending: [],
  provisional: new Map(),
  isLoading: true,
  failure: null,
}

export interface ThreadsStoreOptions {
  /** 没有记下目录的对话落在哪个工作区。答案属于宿主，这一层不猜。 */
  readonly defaultWorkspaceId?: (() => string | null) | undefined
  readonly port?: ThreadPort | undefined
}

/**
 * 一条对话是一份记录：名字、活动时间、置顶、在哪个目录里。整个应用一份。
 *
 * 只有这些。一条对话背后那个活着的会话（握着哪个模型、还能选什么、上次切换成没成）
 * 是另一份状态，住在 session-controls-store.ts，自己有订阅者，不从这里转手。两者
 * 之间只有一根线，方向单一：这里 open 一趟拿回来的整份答复，经 onOpened 交过去。
 *
 * 形制与 workspaceLayoutStore 一致：状态是一个不可变快照，改动经由 #commit
 * 落定，没有真的变化就不通知。这不是风格选择——此前状态摊在七个 useState 上，
 * 由一个每次渲染都新建的对象经 Context 广播出去，于是「某条对话认领到了选择
 * 器」这种局部事实，会让每一个读过这份状态的组件连同它下面整棵树重画一遍。
 *
 * 动作是箭头字段，引用终生不变；因此它们可以直接当 prop 传下去，行组件的
 * 浅比较才第一次真的有东西可比。
 *
 * 名字排名只有一条：用户手打的胜过一切派生的。从第一句话取的替身只活在内存
 * 里，不会被误当成真名；两者都没有时用入口的名字。
 *
 * 曾经排在最上面的是 agent 自己给会话起的标题。平台已经不再上报它，因为那个
 * 标题写一次就再不修改 —— 把它排在用户实际说过的话之上，正是这张列表一度变成
 * 一列「New Session」的原因。
 */
export class ThreadsStore {
  readonly #port: ThreadPort | undefined

  #held: Held = EMPTY

  #listeners = new Set<() => void>()

  /* 想知道「某条对话没了」的人。 */
  #removed = new Set<(threadId: string) => void>()

  /* 想拿到「刚打开一条对话，这是它的整份答复」的人。 */
  #opened = new Set<(answer: OpenedThread) => void>()

  /* 一次索引，而不是每一行各扫一遍整张表。投影交出来的那一份。 */
  #byId: ReadonlyMap<string, ThreadRecord> = new Map()

  /* 快照投影成列表的那一段，连同它逐行复用的缓存。 */
  readonly #projection = new ThreadProjection()

  /** 已归档列表有自己的逐行复用缓存，不能和活动列表共用。 */
  readonly #archivedProjection = new ThreadProjection()

  /*
   * 刚开出来、还没有人开口的那些对话在哪个目录里。
   *
   * 它们不在平台报的列表里（没人说过话的对话不进列表），而第一句话会先在本地
   * 造一行出来（见 noteUserMessage）。那一行也得落进正确的组，否则新建的对话
   * 会先出现在「默认」下面 —— 而且不会自己纠正：提问之后没有任何一处 refresh。
   *
   * 权威仍然只有一个。这里存的就是 open 那一趟平台自己报回来的值，不是本地
   * 猜的；平台认下它之后（refresh）这一格当场删掉。
   */
  #roots = new Map<string, string | null>()

  #list: ThreadsList = { items: NO_ITEMS, isLoading: true, failure: null }

  #archived: ThreadsList = {
    items: NO_ITEMS,
    isLoading: true,
    failure: null,
  }

  /*
   * 没有记下目录的对话落在哪个工作区 —— 一次求值，不是一个值。
   *
   * 与 ipc 的 cwd 同一条规矩（packages/ipc 的 AgentBridgeOptions）：答案
   * 属于宿主，这里不猜。宿主不给，就落回 thread-order 的无名哨兵。复用
   * 缓存按 workspaceId 逐行比较（thread-projection 的 #itemFor），兜底
   * 到达时旧行自然换组，不需要额外的失效逻辑。
   */
  readonly #defaultWorkspaceId: (() => string | null) | undefined

  constructor({ defaultWorkspaceId, port }: ThreadsStoreOptions) {
    this.#port = port
    this.#defaultWorkspaceId = defaultWorkspaceId
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)

    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * 某条对话被删除的那一刻；交回取消订阅的办法。
   *
   * 「这条对话存不存在」的权威只有这一份，所以说得出这句话的也只有这里。
   * 谁需要跟着收拾（工作台上开着它的那一格，以后可能出现的别的观众）由他们
   * 自己来听 —— 而不是让每一个删除入口各自记得再删一遍标签，那是两条写路径。
   */
  onRemoved = (listener: (threadId: string) => void): (() => void) => {
    this.#removed.add(listener)

    return () => {
      this.#removed.delete(listener)
    }
  }

  /**
   * 刚打开一条对话，这是平台交回来的整份答复；交回取消订阅的办法。
   *
   * 打开是这里的动作（create 走 port.open），而那份答复里有一多半不属于这里：会话号、
   * 选择器、经过、附件、已发轮数。发出去，由认得它们的人自己接 —— 这里不替他们转手，
   * 也就不需要知道他们是谁。
   */
  onOpened = (listener: (answer: OpenedThread) => void): (() => void) => {
    this.#opened.add(listener)

    return () => {
      this.#opened.delete(listener)
    }
  }

  getSnapshot = (): Held => this.#held

  /** 侧栏读的那一片。引用只在这一片真的变了时才更换。 */
  listSnapshot = (): ThreadsList => this.#list

  /** 设置页读的已归档列表。 */
  archivedSnapshot = (): ThreadsList => this.#archived

  /** 这条对话现在叫什么。 */
  titleOf = (threadId: string): string =>
    nameOf(this.#byId.get(threadId), this.#held.provisional.get(threadId))

  /** The stand in name a message would give a conversation. */
  standInTitle = (message: string): string => shorten(message)

  refresh = async (): Promise<void> => {
    const port = this.#port

    if (port === undefined) {
      this.#commit({ isLoading: false })

      return
    }

    try {
      const found = await port.list()

      /* 平台认下的行自带工作目录，本地那份替身到此为止。 */
      for (const thread of found) {
        this.#roots.delete(thread.threadId)
      }

      this.#commit({ threads: found, failure: null, isLoading: false })
    } catch (reason) {
      this.#commit({ failure: describeFailure(reason), isLoading: false })
    }
  }

  create = async (): Promise<string | null> => {
    const port = this.#port

    if (port === undefined) {
      return null
    }

    try {
      const opened = await port.open()
      const threadId = opened.thread.threadId

      this.#roots.set(threadId, opened.thread.workspaceRoot ?? null)

      /* 路由、经过、选择器：一份答复到手之后的一切，交给认得它们的人。 */
      for (const listener of this.#opened) {
        listener(opened)
      }

      /*
       * 一条对话在有人开口之前不进列表，所以这里不添行：那会留下一串从未
       * 发生过的对话。
       */
      this.#commit({ failure: null })

      return threadId
    } catch (reason) {
      this.#commit({ failure: describeFailure(reason) })

      return null
    }
  }

  /**
   * 人在这条对话里说了一句话。
   *
   * 两个事实，与库那侧的 record_prompt 一一对应：这条对话刚刚有活动，以及
   * —— 只有它还没有名字时 —— 它从此叫这句话。这里写的是乐观值，库那份权威
   * 会在下一次整表读取时盖上来；两边的规则必须逐字相同，否则那一盖就是一次
   * 肉眼可见的跳变。
   *
   * 平台在第一轮开始时才记下一条对话，所以发出的那一刻读回来可能还没有它。
   * 先把行显示出来、让下一次读取认领走，是列表类界面的常规乐观更新。
   */
  noteUserMessage = (threadId: string, message: string): void => {
    const found = this.#byId.get(threadId)
    const at = new Date().toISOString()

    /*
     * 占位只在这条对话还没有名字的时候写。
     *
     * 有名字了就不该再有占位：那个名字是第一句话，而这一句不是第一句。此前
     * 这里无条件覆盖，于是标题一路跟着最后一句话走。
     */
    const provisional =
      found === undefined || found.titleSource === 'fallback'
        ? withEntry(this.#held.provisional, threadId, shorten(message))
        : this.#held.provisional

    if (found !== undefined) {
      /*
       * 说话就是活动，而列表按活动排（见 #listed）。这一格必须当场跟上：
       * 等库那份回来要到下一次整表读取，那时人早就看着一条没浮上来的对话了。
       */
      this.#commit({
        provisional,
        threads: this.#held.threads.map((thread) =>
          thread.threadId === threadId ? { ...thread, updatedAt: at } : thread,
        ),
      })

      return
    }

    /* 这一行要落进它自己那个组，所以带上 open 时平台报的目录。undefined 是
    「这条不是本次运行开出来的」，那时缺席仍然是缺席。 */
    const root = this.#roots.get(threadId)

    const pending = this.#held.pending.some((thread) => thread.threadId === threadId)
      ? this.#held.pending
      : [
          ...this.#held.pending,
          {
            threadId,
            sessionId: null,
            title: shorten(message),
            titleSource: 'message' as const,
            updatedAt: at,
            ...(root === undefined ? {} : { workspaceRoot: root }),
          },
        ]

    this.#commit({ pending, provisional })
  }

  /*
   * 改名与置顶：先改本地，再落库。落库失败由 #settle 向权威重问一次回滚。
   *
   * 立刻可见是列表类界面的通行做法，而真相仍然只有一个来源；端口没有实现
   * 某个动作时什么都不做，界面不会假装做过。
   *
   * 删除不在这一类里，理由见 remove 自己那一段。
   */
  rename = async (threadId: string, title: string): Promise<void> => {
    const act = this.#port?.rename
    const named = title.trim()

    if (act === undefined || named.length === 0) {
      return
    }

    this.#commit({
      threads: this.#held.threads.map((thread) =>
        thread.threadId === threadId
          ? { ...thread, title: named, titleSource: 'manual' as const }
          : thread,
      ),
      provisional: withoutEntry(this.#held.provisional, threadId),
    })

    await this.#settle(act(threadId, named))
  }

  remove = async (threadId: string): Promise<void> => {
    const act = this.#port?.remove

    if (act === undefined) {
      return
    }

    /*
     * 删除先落库，再在本地生效。这一条与改名、置顶反过来，是有理由的。
     *
     * 那两个是可逆的属性变更：乐观更新失败了，向权威重问一次就回到原样。删除
     * 不是。它向 #removed 广播，工作台关掉开着它的那一格、会话与经过跟着作废
     * —— 这些都不是一次 refresh 能复原的，于是「先删本地再落库」在失败时留下的
     * 是一份谁都没认可的状态：屏幕上没有了，盘上还在。
     *
     * 破坏性动作等一次本地往返（落的是本机 SQLite，不是网络），换的是「屏幕上
     * 没有的东西盘上也没有」。
     */
    try {
      await act(threadId)
    } catch (reason) {
      this.#commit({ failure: describeFailure(reason) })

      return
    }

    this.#roots.delete(threadId)

    this.#commit({
      threads: this.#held.threads.filter((thread) => thread.threadId !== threadId),
      pending: this.#held.pending.filter((thread) => thread.threadId !== threadId),
      failure: null,
    })

    /*
     * 会话与经过随对话一起作废，由听的人自己收拾。
     *
     * 与 onRemoved 那一段是同一条规矩：说得出「这条对话没了」的只有这里，跟着要
     * 收拾什么由各自决定。此前这里点名叫了两台 store 的 forget，那是把「谁存了这
     * 条对话的东西」这份知识抄在了删除入口上 —— 再多一个存东西的人就要再抄一遍。
     */
    for (const listener of this.#removed) {
      listener(threadId)
    }
  }

  archive = async (threadId: string, archived: boolean): Promise<void> => {
    const act = this.#port?.archive

    if (act === undefined) {
      return
    }

    /*
     * 先让后端落定。Kimi 官方 state.json 与本地索引都成功后，界面才移动这一行，
     * 避免出现屏幕已经归档、磁盘实际没有归档的状态。
     */
    try {
      await act(threadId, archived)
    } catch (reason) {
      this.#commit({
        failure: describeFailure(reason),
      })

      return
    }

    this.#commit({
      threads: this.#held.threads.map((thread) =>
        thread.threadId === threadId ? { ...thread, archived } : thread,
      ),
      failure: null,
    })

    /*
     * 归档后它离开活动工作区。打开的标签、选择器和转录跟着离场；
     * 取消归档只把它放回列表，不擅自重新打开。
     */
    if (archived) {
      for (const listener of this.#removed) {
        listener(threadId)
      }
    }
  }

  setPinned = async (threadId: string, pinned: boolean): Promise<void> => {
    const act = this.#port?.setPinned

    if (act === undefined) {
      return
    }

    this.#commit({
      threads: this.#held.threads.map((thread) =>
        thread.threadId === threadId ? { ...thread, pinned } : thread,
      ),
    })

    await this.#settle(act(threadId, pinned))
  }

  /*
   * 一次乐观写入的收尾。改名与置顶走这里，删除不走。
   *
   * 失败时先向权威重问一次，与 selectControl 的 catch 同一个办法：回滚是把真相
   * 拉回来，不是在本地猜一个旧值填回去。此前这里只写一句 failure，于是改名失败
   * 之后屏幕上留着的是那个没写进去的新名字。
   *
   * 顺序不能反：refresh 成功时自己会提交 failure: null，那句话必须排在它后面。
   */
  async #settle(work: Promise<unknown>): Promise<void> {
    try {
      await work
      this.#commit({ failure: null })
    } catch (reason) {
      await this.refresh()
      this.#commit({ failure: describeFailure(reason) })
    }
  }

  #commit(patch: Partial<Held>): void {
    const next: Held = { ...this.#held, ...patch }

    /*
     * 变化检查按 patch 的键走。
     *
     * 此前这里手抄了 Held 的七个字段。手抄的那份在加第八个字段时会静默漏掉,
     * 而漏掉的表现是"改了却不通知" —— 一个只在特定字段上发作的 bug。没被 patch
     * 的字段不可能变,所以按键比较既短,也不可能忘。
     */
    if ((Object.keys(patch) as (keyof Held)[]).every((key) => next[key] === this.#held[key])) {
      return
    }

    /*
     * 列表的输入只有这三样。
     *
     * 一行的样子只由 threads / pending / provisional 决定(见 #itemFor):
     * isLoading 与 failure 对它零影响。会话那一侧的选择器如今连 Held 都不在,
     * 它有自己的快照;此前它们同住一屋,每一次提交都重跑 #project:重建 #byId、
     * 重算每一行的标题、重建 #items。打开 40 条对话就是 40 趟 O(N) 的无用功。
     *
     * 派生视图只在它的输入变化时重算,这是 store 派生状态的基本形态。
     */
    const listing =
      next.threads !== this.#held.threads ||
      next.pending !== this.#held.pending ||
      next.provisional !== this.#held.provisional

    this.#held = next

    if (listing) {
      this.#project()
    } else if (next.isLoading !== this.#list.isLoading || next.failure !== this.#list.failure) {
      /* 只有加载与错误变了，两张列表都保留原来的 items 引用。 */
      this.#list = {
        items: this.#list.items,
        isLoading: next.isLoading,
        failure: next.failure,
      }

      this.#archived = {
        items: this.#archived.items,
        isLoading: next.isLoading,
        failure: next.failure,
      }
    }

    this.#announce()
  }

  #announce(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  /*
   * 投影住在 thread-projection：一行长什么样、按什么次序，与分组同一个模块。
   *
   * 「整张列表没变就连数组都不换」在那一侧完成，所以这里只剩一次引用比较 ——
   * 它与此前那个 same 提前返回是同一个判据，只是短了。
   */
  #project(): void {
    const activeThreads = this.#held.threads.filter((thread) => thread.archived !== true)

    const archivedThreads = this.#held.threads.filter((thread) => thread.archived === true)

    const active = this.#projection.of(
      activeThreads,
      this.#held.pending,
      this.#held.provisional,
      this.#defaultWorkspaceId?.() ?? undefined,
    )

    const archived = this.#archivedProjection.of(
      archivedThreads,
      [],
      NO_PROVISIONAL,
      this.#defaultWorkspaceId?.() ?? undefined,
    )

    this.#byId = new Map([...active.byId, ...archived.byId])

    const { failure, isLoading } = this.#held

    if (
      active.items !== this.#list.items ||
      this.#list.isLoading !== isLoading ||
      this.#list.failure !== failure
    ) {
      this.#list = {
        items: active.items,
        isLoading,
        failure,
      }
    }

    if (
      archived.items !== this.#archived.items ||
      this.#archived.isLoading !== isLoading ||
      this.#archived.failure !== failure
    ) {
      this.#archived = {
        items: archived.items,
        isLoading,
        failure,
      }
    }
  }
}
