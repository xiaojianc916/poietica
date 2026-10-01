/*
 * 桥与 Rust 之间的线上形状。
 *
 * 这是我们自己的协议，不是 omp 的 RPC 模式：omp 没有 kap 那样的增量 transcript
 * 通道，而屏幕经过必须走 transcript（AGENTS.md §2）。桥订阅 SDK 的 typed event，
 * 投影成 packages/transcript 已经钉住的 ops/reset，与命令应答同走一条 stdout。
 *
 * 判别式与字段都用 camelCase：Rust 侧 serde 直接对，不做第二套命名。
 */

/** Rust → 桥。一行一条，id 由 Rust 签发，应答原样回。 */
export type BridgeCommand =
  | { readonly id: string; readonly type: 'new_session'; readonly cwd: string }
  /**
   * 重装一条以前开过的会话。`cwd` 是这条对话记下的工作区；应答是
   * `{sessionId, controls}`，会话文件已经不在了就回 `{sessionId: null}`。
   */
  | {
      readonly id: string
      readonly type: 'load_session'
      readonly sessionId: string
      readonly cwd: string
    }
  | {
      readonly id: string
      readonly type: 'prompt'
      readonly text: string
      readonly promptId: string
      /**
       * 这句话怎么进 agent —— omp 的三层插话，打断程度递减（agent-session.ts:7843-7903）：
       *
       * - `turn`：开一轮。空闲时的正常发送；正在跑时上游抛 AgentBusyError，所以这一格
       *   在流式中**不会**被选（产品在流式里选下面三层）。
       * - `steer`：插进正在跑的那一轮，在工具批次之间被模型看到（`session.steer`）。
       * - `followUp`：不打断，本轮跑完后自动作为下一轮输入（`session.followUp`）。
       * - `aside`：完全非中断，在 step 边界静默注入，绝不打断在跑的工具批
       *   （`session.sendUserMessage(content, {deliverAs: 'aside'})`）。
       *
       * 只有 `steer`/`followUp`/`aside` 是插话；后两者的存续期与队列都在 agent 里，
       * 这一侧不留副本（AGENTS.md §1「每一类状态有且只有一个所有者」）。
       */
      readonly deliverAs: 'turn' | 'steer' | 'followUp' | 'aside'
      /**
       * 随这句话带上的附件；每一格交的是磁盘绝对路径 + kind + mime + 名字。
       * 对象而非裸路径：SDK 收图只有 base64 一条路（`PromptOptions.images:
       * ImageContent[]`，agent-session-types.ts:345-349），桥按路径读盘同官方 CLI
       * （file-processor.ts:104-129）。`kind` 是唯一分派判据：image 的像素由桥读出
       * 交给 ImageContent，file 只把路径当引用。
       * `mime` 唯一产地是 Rust formats.rs 的 classify()（经 gateway.rs 的
       * materialise() 带来），桥不得按扩展名反推 —— 剪贴板粘贴的图叫
       * `pasted-<uuid>`，没有扩展名。
       */
      readonly attachments: readonly {
        readonly path: string
        readonly kind: 'image' | 'file'
        readonly mime: string
        readonly name: string
      }[]
      readonly skills: readonly { readonly name: string; readonly args?: string }[]
    }
  | { readonly id: string; readonly type: 'cancel' }
  /**
   * 队列此刻的事实：两层的待发正文与三个队列模式。
   *
   * 队列归 agent（`AgentSession.getQueuedMessages()` 只给可恢复的用户消息，
   * `queuedMessageCount` 还含 nextTurn 与 advisor 卡），本层不替它记一份。
   */
  | { readonly id: string; readonly type: 'queue' }
  /**
   * 撤回最后一条还排着的插话，交回正文（LIFO，`popLastQueuedMessage()`）。
   *
   * 上游只有这一种撤回：它先看 steering 再看 followUp，并且会连带取走紧挨在它
   * 前面的隐藏伴生消息（agent-session.ts:7958-7992）。没有「按号撤回」那一说。
   */
  | { readonly id: string; readonly type: 'withdraw' }
  /**
   * 改三个队列模式；缺席的格不改。
   *
   * steeringMode/followUpMode 是 `all | one-at-a-time`（默认后者：一次只喂一条），
   * interruptMode 是 `immediate | wait`（默认前者：截断可中断的等待）。上游的
   * `setSteeringMode/setFollowUpMode/setInterruptMode(mode, persist)` 默认落盘到
   * agent 自己的 config.yml —— 配置真身就是它自己那一份，所以这里照它的默认来。
   */
  | {
      readonly id: string
      readonly type: 'delivery'
      readonly steeringMode?: 'all' | 'one-at-a-time'
      readonly followUpMode?: 'all' | 'one-at-a-time'
      readonly interruptMode?: 'immediate' | 'wait'
    }
  /**
   * 从某一轮分叉出一条新会话：丢掉末尾 `dropTurns` 轮，从更早那一点另起一条。
   *
   * 上游的原语是 `AgentSession#branch(entryId)`（它调 `createBranchedSession` 再重锚），
   * 不是 `SessionManager#fork()` —— 后者整份复制、一轮都不丢，做不出这个契约。
   * `dropTurns === 0` 才走整份复制。
   */
  | {
      readonly id: string
      readonly type: 'fork_session'
      readonly sessionId: string
      readonly dropTurns: number
    }
  /** 删掉一条会话文件与其产物目录；不存在的会话按失败回，不假装删掉了。 */
  | { readonly id: string; readonly type: 'delete_session'; readonly sessionId: string }
  /** 把一条会话导成一份自包含的 HTML，落点是绝对路径。 */
  | {
      readonly id: string
      readonly type: 'export_session'
      readonly sessionId: string
      readonly destination: string
    }
  /**
   * 把一条会话传到 omp 自己的分享服务，换取一条链接。
   *
   * 应答是 `{url, truncated}`：`url` 就是给人点的那一条，`truncated` 说明内容为了
   * 塞进上行预算被裁过。其余几格（method / gistUrl / sealedBytes）是 omp 的实现
   * 细节，屏幕上没有它们的位置，本层不转发 —— 转发就得有人解释它们。
   *
   * **这是唯一一条把对话正文送出本机的命令**，所以脱敏那一格在桥里按 omp 自己的
   * 规矩办（见 bridge.ts 的 shareSession）。
   */
  | { readonly id: string; readonly type: 'share_session'; readonly sessionId: string }
  /** 回答一次工具授权。decision 与 scope 是产品那三颗按钮的取值域。 */
  | {
      readonly id: string
      readonly type: 'answer_permission'
      readonly requestId: string
      readonly decision: 'approved' | 'rejected' | 'cancelled'
      readonly scope?: 'session'
    }
  /**
   * 回答一个对话框（授权走 answer_permission；这条给别的对话框用）。
   *
   * - 题组（`questions_asked` 那一种）：`response` 是产品形状的答复，由桥折回上游要的
   *   results；空答案表就是「撤下整组」。
   * - 其余（confirm / input / editor）：原样转发上游的响应形状。
   *
   * 判据是「这个号是不是一组还在等的题」，不是载荷长什么样。
   */
  | {
      readonly id: string
      readonly type: 'answer_dialog'
      readonly requestId: string
      readonly response: unknown
    }
  | { readonly id: string; readonly type: 'selectors' }
  | {
      readonly id: string
      readonly type: 'select'
      readonly configId: string
      readonly value: string
      /**
       * 与这次改动一起交上去的一段文字（目标那一格用它当 objective）。
       *
       * 可缺席，**且只对认它的那一格有意义** —— 别的选择器忽略它，不是把它塞进
       * value。Rust 的 Option::None 到这边是 null，所以写成 `?: string | null`。
       */
      readonly input?: string | null
    }
  /** 目标模式此刻的事实；`data.goal` 为 null 就是这条会话没有目标。 */
  | { readonly id: string; readonly type: 'goal' }
  /** 屏幕经过的一页：打开一条会话时的基线。 */
  | {
      readonly id: string
      readonly type: 'transcript'
      readonly sessionId: string
      readonly agentId: string
      readonly beforeTurn: string | null
    }
  /** 从某个水位起的增量。 */
  | {
      readonly id: string
      readonly type: 'transcript_ops'
      readonly sessionId: string
      readonly agentId: string
      readonly sinceSeq: number
    }
  | { readonly id: string; readonly type: 'sessions' }
  | { readonly id: string; readonly type: 'capabilities' }
  /**
   * 打开一项本机能力。
   *
   * 名字沿用产品那一页的叫法（capability-gateway 的 installCapability），而 omp 里
   * 这一项**没有安装这一步**：桌面控制是构建期编进来的 eval 前奏，只有开与关。
   * 桥把它收成官方那两步（`settings.override` + `refreshBaseSystemPrompt`），
   * 应答是改完之后的能力清单。
   */
  | {
      readonly id: string
      readonly type: 'install_capability'
      readonly capabilityId: string
      /** 打开还是关上。omp 里这一项只有这两个方向，没有「安装」。 */
      readonly enabled: boolean
    }
  /** 读 agent 的浏览器控制设置。 */
  | { readonly id: string; readonly type: 'browser_settings' }
  /**
   * 写 agent 的浏览器控制设置；缺席的格不改。`cdpUrl` 给空串即清掉
   * （回到托管启动），给了地址就是附着到那个 CDP 端点而不是自己拉浏览器。
   */
  | {
      readonly id: string
      readonly type: 'set_browser_settings'
      readonly enabled?: boolean
      readonly headless?: boolean
      readonly cdpUrl?: string
    }
  | { readonly id: string; readonly type: 'skills' }
  | { readonly id: string; readonly type: 'mcp_servers' }
  /**
   * agent 自己的设置目录。
   *
   * 逐格从 omp 的 settings-schema 读出来（label / description / 类型 / 选项 / 默认值
   * 都是它自报的），我们不抄一份 —— 抄一份就是第二个事实，升级即分叉。
   *
   * `secret` 为真的那几格**只报有没有值**，绝不报值本身：那是钥匙，
   * 出了 agent 的进程就不再是我们的盘（AGENTS.md §1「密钥永不落我们的盘」）。
   */
  | { readonly id: string; readonly type: 'settings_catalog' }
  /**
   * 改 agent 自己的一个设置。
   *
   * 走它自己的持久层（Settings.set + flush），由它自己热重载 —— 不手搓 config.yml。
   */
  | {
      readonly id: string
      readonly type: 'set_setting'
      readonly path: string
      readonly value: unknown
    }
  /**
   * 模型目录的一次读或一次改。
   *
   * 读返回 providers / models / catalog / defaultModel；改接 setDefault 与
   * provider 的增删改（写进 agent 自己的 models.yml 与 config.yml）。
   */
  | {
      readonly id: string
      readonly type: 'model_catalog'
      readonly operation: ModelCatalogOperation
    }
  | { readonly id: string; readonly type: 'shutdown' }

/*
 * 一次 provider 输入；与 crates/agent-client 的 ProviderInput 逐字对应。
 *
 * 可缺席的格一律写成 `?: T | null`：这份形状是从 Rust 那条 JSON 线上解出来的，
 * Rust 的 `Option::None` 到这边是 `null`，不是 `undefined`。只写 `undefined` 会让
 * 下游误以为 `x === undefined` 就够判缺席 —— 那正是「null is not an object」的来源。
 */
export interface ProviderInput {
  readonly id: string
  readonly providerType: string
  readonly apiKey?: string | null
  readonly baseUrl?: string | null
  readonly defaultModel?: string | null
  readonly models: readonly ProviderModelInput[]
}

export interface ProviderModelInput {
  readonly model: string
  readonly maxContextSize: number
  readonly displayName?: string | null
  readonly capabilities?: readonly string[] | null
  readonly maxOutputSize?: number | null
  readonly supportEfforts?: readonly string[] | null
  readonly adaptiveThinking?: boolean | null
}

export interface ProviderReplacement extends Omit<ProviderInput, 'id'> {
  readonly newId?: string | null
}

/** 与 crates/agent-client 的 ModelCatalogOperation 逐字对应。 */
export type ModelCatalogOperation =
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'refreshProviders' }
  | { readonly kind: 'setDefault'; readonly modelId: string }
  /** 给一个 provider 配一把钥匙；落 agent 自己的凭据库（agent.db）。 */
  | { readonly kind: 'setApiKey'; readonly provider: string; readonly apiKey: string }
  /** 删一个 provider：钥匙从 agent.db 删，定义从 models.yml 删，provider 停用。 */
  | { readonly kind: 'delete'; readonly providerId: string }
  /** 建一个 provider；定义写 agent 自己的 models.yml。 */
  | { readonly kind: 'create'; readonly provider: ProviderInput }
  /** 整份换掉一个 provider；`newId` 给了就是改名。 */
  | {
      readonly kind: 'replace'
      readonly providerId: string
      readonly provider: ProviderReplacement
    }
  /**
   * 从 agent 自己的内置目录添加一个 provider。
   *
   * 目录里那一行已经带着 baseUrl / api / 模型清单，所以只有改端点（`baseUrl`）或
   * 改 id（`id`）时才写 models.yml；原样添加只写钥匙并解除停用。
   */
  | {
      readonly kind: 'importCatalog'
      readonly catalogId: string
      readonly apiKey?: string | null
      readonly baseUrl?: string | null
      readonly id?: string | null
    }

export type BridgeCommandType = BridgeCommand['type']

/** 桥 → Rust。 */
export type BridgeFrame =
  | {
      readonly type: 'ready'
      /** 桥自己的协议版本，不是 omp 的。 */
      readonly protocolVersion: number
      readonly agentVersion: string
    }
  | { readonly type: 'response'; readonly id: string; readonly data?: unknown }
  | { readonly type: 'failed'; readonly id: string; readonly message: string }
  | { readonly type: 'event'; readonly event: BridgeEvent }

/** 桥主动推的事件；Rust 侧落成 SessionEvent。 */
export type BridgeEvent =
  /** transcript 的一批增量或一次整发；payload 就是线上 transcript 帧。 */
  | {
      readonly kind: 'transcript'
      readonly sessionId: string
      readonly payload: unknown
    }
  /**
   * 这一轮按 agent 自己的说法结束了。
   *
   * 单独报一条而不是让 Rust 去读 transcript ops 里的 turn 状态：那等于让通用层
   * 解析协议内部形状，是第二个判别点。轮终是本机账本要记的事实，由知道的人报。
   */
  | {
      readonly kind: 'turn_end'
      readonly sessionId: string
      readonly outcome: 'completed' | 'cancelled' | 'failed'
      readonly message?: string
    }
  /**
   * 这条会话此刻能改的选择器，以及此刻的目标。
   *
   * 目标与选择器同车：两者都是「此刻这条会话是什么样」，而目标会在一次工具调用
   * 里被 agent 自己改掉（`goal_updated`），分开报就会有两个到达时刻。
   */
  | {
      readonly kind: 'selectors'
      readonly sessionId: string
      readonly controls: readonly SelectorControl[]
      readonly goal: GoalSnapshot | null
    }
  /**
   * agent 要问一个对话框。
   *
   * `request` 是上游 RpcExtensionUIRequest 的原样形状（method 为 select / confirm /
   * input / editor / notify / …）。授权那一类（method=select 且选项是那四档）由
   * Rust 翻成产品的一问一答；其余原样交给宿主，本层不解释。
   */
  | {
      readonly kind: 'dialog_requested'
      readonly sessionId: string
      readonly request: unknown
    }
  /** 一次会话的用量快照。 */
  | {
      readonly kind: 'usage'
      readonly sessionId: string
      readonly usage: UsageSnapshot
    }
  /**
   * agent 的 ask 工具在等人答一组题。`questions` 已是产品形状（与 packages/conversation
   * 的 QuestionItem 同形）：omp 的载荷在桥里折过一次，题的形状是 agent 专属知识
   * （AGENTS.md §4）。号由桥签发，答案按同一个号回来，走既有 `answer_dialog` 命令
   * 不新开一条：那是同一条路的两端。
   */
  | {
      readonly kind: 'questions_asked'
      readonly sessionId: string
      readonly requestId: string
      readonly questions: readonly AskedQuestion[]
    }
  /**
   * 待发队列变了（有人排了一句 / 有人撤回 / agent 在 step 边界把它喂给了模型）。
   *
   * 队列的真相在 agent 里，这条只是把它此刻的样子推出去；读命令 `queue` 是同一份。
   * 上游没有队列变更事件，所以推送点由桥自己认：投递插话之后、撤回之后、改模式之后、
   * 轮终之后，以及**模型真的看见那句话**时（注入消息的 message_start）。
   */
  | {
      readonly kind: 'queue'
      readonly sessionId: string
      readonly queue: QueuedState
    }
  /**
   * 这一句在入队前就被取消了（abort 或用量预检竞态），**没有落进会话文件**。
   *
   * 上游的 `setPromptDropped`（agent-session.ts:8335）只在这两种竞态里响一次；不接它
   * 就等于用户那句话凭空消失 —— 屏幕上那条乐观记录还挂着，agent 永远不回应答。
   * 正文是**人打的原样**（模板与斜杠命令展开之前）。
   */
  | {
      readonly kind: 'prompt_dropped'
      readonly sessionId: string
      readonly text: string
    }

export interface SelectorControl {
  readonly id: string
  /** 这一格在人面前叫什么；缺席时原生侧退回用 id 当名字。 */
  readonly label?: string
  readonly purpose: 'model' | 'thinking' | 'permission' | 'mode' | 'other'
  /**
   * 这一档改完不算数，要等下一句交出去时才生效（值跟着 prompt 一起送）。
   *
   * 目标那一格就是这一档：开目标要有正文当 objective，而正文是用户下一句要写的话。
   * 面板据此把这行画成「待提交」而不是当场发一条 set_config —— 当场发没有正文，只能被拒。
   */
  readonly appliesOnSubmit?: true
  readonly current: string
  readonly choices: readonly SelectorChoice[]
}

export interface SelectorChoice {
  readonly value: string
  readonly label: string
  /** 这一档的说明；缺席即没有话要说。与 crates/agent-client 的 ConfigChoice 同形。 */
  readonly detail?: string
}

/**
 * 目标模式此刻的事实。
 *
 * 与 crates/agent-client 的 GoalSnapshot、以及桌面的 AgentGoal 逐字同形（camelCase），
 * 所以 Rust 侧 serde 直接对，不做第二套命名。
 *
 * `status` 已经是产品那四个词（active / paused / blocked / complete）：omp 自己的
 * `GoalStatus`（多 budget-limited 与 dropped 两档）在桥里折一次，通用层不认识它。
 */
export interface GoalSnapshot {
  readonly objective: string
  /** omp 的目标没有「完成判据」这一格，恒为 null，不编一个。 */
  readonly completionCriterion: string | null
  readonly status: string
  /** 同上：omp 不按目标记轮数，恒为 0。 */
  readonly turnsUsed: number
  readonly tokensUsed: number
  readonly wallClockMs: number
}

/**
 * 待发队列此刻的样子，以及三个队列模式的取值。
 *
 * `steering` 与 `followUp` 都是**已经交给 agent 的**用户消息正文（上游
 * `getQueuedMessages()` 只挑可恢复的用户消息；aside 不进这两个队列，它在 IRC 那条
 * 旁路上，因此不在这里）。顺序就是出队顺序。
 */
export interface QueuedState {
  /** 这份队列属于哪条会话。队列是会话级的事实，屏幕按对话订阅，认领要用它。 */
  readonly sessionId: string
  readonly steering: readonly string[]
  readonly followUp: readonly string[]
  readonly steeringMode: 'all' | 'one-at-a-time'
  readonly followUpMode: 'all' | 'one-at-a-time'
  readonly interruptMode: 'immediate' | 'wait'
}

/** 撤回的应答：`text` 为 null 就是队列本来就空着。 */
export interface WithdrawnMessage {
  readonly text: string
}

export interface UsageSnapshot {
  readonly used: number
  readonly size: number
  readonly inputOther: number
  readonly inputCacheRead: number
  readonly inputCacheCreation: number
  /**
   * 此刻这份上下文由什么构成。缺席即这一份报数没带构成：屏幕退成只画总条，
   * 不拿别的数字凑几行。
   */
  readonly breakdown?: UsageBreakdown
}

/**
 * 上下文构成，与 omp 自己在状态行里显示的那份逐格对应。
 *
 * 七格全报，不按屏幕的行数折：缺哪一格由屏幕决定画不画，桥不替它做减法 ——
 * 折过一次就会出现「屏幕上那一行的数不等于 agent 说的数」。
 */
export interface UsageBreakdown {
  readonly systemPrompt: number
  readonly systemContext: number
  readonly systemTools: number
  readonly skills: number
  readonly messages: number
  /** 还没用上的量。 */
  readonly free: number
  /** 为自动压缩留的缓冲。 */
  readonly autoCompactBuffer: number
}

/**
 * 一道等答的题，产品形状。与 packages/conversation 的 QuestionItem 逐字同形，但少三格
 * （`body`；`otherLabel` / `otherDescription` —— omp 的「Other」是它自己固定的一句），
 * 如实缺席而不是编一句。`options[].id` 是桥现编的：omp 的选项只有标签，号必须在
 * 桥这一侧与标签对上 —— 那是答案能被翻译回 omp 的唯一依据。
 */
export interface AskedQuestion {
  readonly id: string
  readonly question: string
  /** 题上方的短标签。omp 可缺席。 */
  readonly header?: string
  readonly options: readonly AskedQuestionOption[]
  readonly multiSelect: boolean
  /** omp 的 ask 恒定允许自答（tools/ask.ts 的 OTHER_OPTION），所以恒 true。 */
  readonly allowOther: boolean
}

export interface AskedQuestionOption {
  /** 桥签发的号；答案按它回来。 */
  readonly id: string
  readonly label: string
  readonly description?: string
}

/**
 * agent 自己那一格设置的说明书。
 *
 * 全部字段都是 omp 的 settings-schema 自报的，不是我们抄的：`label` / `description`
 * 由它给（我们只负责画），`options` 是它自己那张选项表。升级 omp 时这一份跟着变，
 * 我们没有需要同步的第二份。
 */
export interface SettingEntry {
  readonly path: string
  readonly type: string
  readonly label: string
  readonly description: string
  /** 所在的那一节。 */
  readonly group?: string
  /** 未设置时生效的值；界面用它做「默认」提示。 */
  readonly default: unknown
  /** 此刻生效的值；`secret` 为真时恒为 null（值不出 agent 的进程）。 */
  readonly value: unknown
  /** 是不是钥匙。为真时 `value` 恒为 null，只有 `hasValue` 说话。 */
  readonly secret: boolean
  /** 钥匙有没有配过；非钥匙恒为 false。 */
  readonly hasValue: boolean
  /** 枚举/子菜单那张选项表；缺席即这一格没有固定选项。 */
  readonly options?: readonly SettingOption[]
  /** 枚举的取值域，给没有 options 的那些用。 */
  readonly enumValues?: readonly string[]
  /** 风险提示（会把用户拉进限流或被封的那类设置）。 */
  readonly warning?: string
  /**
   * 可见性条件名（omp 自己的写法，如 `advisorEnabled`）。
   *
   * 只有名字，不是判据：求值要用**此刻的设置**，那是界面这一侧的事，
   * 我们不把一张条件表从 agent 的进程搬到这儿。
   */
  readonly condition?: string
  /**
   * 所在分节的中文名。分组仍按 `group`（agent 自己的词）分：键不能译，
   * 译了同一节会分裂成两节；这里只是给人看的那一列。
   */
  readonly groupLabel?: string
  /**
   * 这一格的**行**由产品别处的控件负责。值仍然要报：别的格子按 `condition` 读它的
   * value 决定显不显示，把值一起抽掉会让依赖它的那几行悄悄消失 —— 比重复控件更难发现。
   */
  readonly owned?: boolean
  /**
   * 这一格归产品哪一个**剥离页**画（「记忆」/「个性化」，后者本没有对应的 tab，
   * 见 settings-labels.ts 的 `personaSettingOf`）。缺席即不属于任何剥离页。
   * 与 `owned` 正交：`owned` 说「这一行别处已有控件」，section 说「归哪一页」；
   * 一格可以既有归属又 owned（`defaultThinkingLevel`），那一页也不画它的行。
   */
  readonly section?: 'memory' | 'persona'
}

export interface SettingOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/**
 * 设置目录：agent 自报的那几格设置。
 *
 * 目录整份一次交回（记忆与个性化两页各取归属自己的一段），不按栏切。
 */
export interface SettingsCatalog {
  readonly settings: readonly SettingEntry[]
}

export const BRIDGE_PROTOCOL_VERSION = 2

/**
 * 一张随话带上的图的上限（字节）。
 *
 * 与 omp 官方 CLI 同一条判据（cli/file-processor.ts:25 的 25MB）：base64 之后还要膨胀
 * 四分之三，再大是 OOM 不是报错。正本在这里，桥读盘时按它拦。
 */
export const MAX_PROMPT_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * 单行上限：**对端的合理性检查**，不是载荷契约。
 *
 * 与 crates/agent-client/src/wire.rs 的 `MAX_LINE_BYTES` 同值，两侧一起改。
 * 超了说明对端不是我们的桥（或流已错位），判连接死掉。
 *
 * 取值由**不可再切的最大单条载荷**推出来，不是拍的：一条 op 装不下时只能独占一行，
 * 而最大的那种 op 是内联图片（`attachment.upsert` 的 data URL）—— 上限 25 MB 的图
 * base64 后约 33.4 MB。取它的两倍留一倍余量。
 *
 * 旧值 1 MiB 是错的：一条 108 次工具调用的会话，基线页就有 1.26 MB，正常对话被这个
 * 检查判成了坏对端（症状：点进那条对话报「agent 已经退出」）。保证不超限的是生产者
 * 自己收口 —— transcript-mirror 按字节预算切块与开窗，这里只兜底。
 */
export const MAX_FRAME_BYTES = 2 * MAX_PROMPT_IMAGE_BYTES
