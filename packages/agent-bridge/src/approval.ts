/*
 * 给 SDK 的 uiContext：把 agent 的对话框接到我们这条 stdio 上。
 *
 * 这是 SDK 自己的扩展面（CreateAgentSessionResult.setToolUIContext 收的就是它），
 * 不是 RPC 模式的实现：ExtensionUIContext 是上游给宿主定的接口，谁嵌它谁实现。
 * 我们只实现问得出人的那几个（select / confirm / input / editor），其余是交互式
 * TUI 的面，嵌入方没有也不该有。
 *
 * 授权闸门（extensibility/extensions/wrapper.ts）在没有 UI 时 fail closed：非 yolo
 * 模式下每一次 write/exec 都会抛「requires approval but no interactive UI
 * available」。所以这不是加功能，是让这条路不堵死。
 *
 * 一问一答的形状照上游 RpcExtensionUIResponse：`{ type, id, ...载荷 }`，载荷三种
 * 取值（value / confirmed / cancelled）由各自的对话框自己解释。
 */

import type {
  ExtensionAskDialogQuestion,
  ExtensionAskDialogResult,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionUISelectItem,
} from '@oh-my-pi/pi-coding-agent'

/**
 * 授权闸门问的那两颗按钮。
 *
 * 正本是上游 extensibility/extensions/wrapper.ts 的
 * `uiContext.select(safetyPrompt, ["Approve", "Deny"])` —— 它没有给授权单独一个
 * method，靠选项集区分。这两个标签是这条路的协议字面量，两侧（这里与 Rust 的
 * approval_of）必须逐字一致。
 */
export const APPROVAL_OPTIONS: readonly [string, string] = ['Approve', 'Deny']

/** 上游对话框请求的原样形状；只列我们读的格，认不得的都当缺席。 */
export interface UpstreamDialogRequest {
  readonly method?: unknown
  readonly title?: unknown
  readonly options?: unknown
  readonly questions?: unknown
}

/**
 * 一次对话框的答复，收窄到上游那三格。
 *
 * 上游 RpcExtensionUIResponse 的载荷就这三种取值（value / confirmed / cancelled），
 * 各自的对话框解释自己那一格。`scope` 是我们自己加的第四格：产品那三颗按钮里
 * 「本次会话都批准」与「批准」在上游是同一颗，只有我们知道人点的是哪一颗。
 */
export interface UpstreamDialogResponse {
  readonly value?: unknown
  readonly confirmed?: unknown
  readonly cancelled?: unknown
  readonly scope?: unknown
}

export function responseOf(payload: unknown): UpstreamDialogResponse {
  return typeof payload === 'object' && payload !== null ? payload : {}
}

/**
 * 这道对话框是不是授权闸门那一次；是就交出工具名。
 *
 * 判据是「method 为 select，且选项正好是那两颗」，与 Rust 的 approval_of 同一句 ——
 * 两处各判一次就会一半认得一半认不得。
 *
 * 工具名从标题里取：上游的 select 只给一句话（tools/approval.ts 的 formatApprovalPrompt
 * 第一行是 `Allow tool: <name>`），没有结构化的字段。取不到就是空串 —— 那一格只用于
 * 屏幕上的说法与会话级放行的设置键，空串时两件都不做，不编一个名字。
 */
export function approvalToolOf(request: UpstreamDialogRequest): string | null {
  if (request.method !== 'select') {
    return null
  }

  const options = request.options

  if (!Array.isArray(options) || options.length !== APPROVAL_OPTIONS.length) {
    return null
  }

  const labels = options.filter((option): option is string => typeof option === 'string')

  if (!APPROVAL_OPTIONS.every((label) => labels.includes(label))) {
    return null
  }

  return approvalToolName(request)
}

/**
 * 这道对话框要批准的那件事本身。
 *
 * 「要不要允许 Bash」回答不了任何问题：人要知道的是**将跑哪条命令**。上游已经把它
 * 算好了 —— tools/approval.ts 的 formatApprovalPrompt 把工具自报的细节（bash 的
 * `Command: …`、write 的路径、edit 的新旧正文）逐行拼在同一句话里，紧接着
 * `Allow tool: <name>` 那一行。这里只把原文里那几行取出来，**不重排、不翻译**：
 * 它是什么样，屏幕上就该是什么样。
 *
 * 没有 `Allow tool:` 那一行的（计划提交那类：整句标题本身就是被批准的东西），
 * 整句就是细节。调用方已经先验过它确实是这次闸门，所以这里不必再筛。
 */
export function approvalDetailOf(request: UpstreamDialogRequest): string | null {
  const title = typeof request.title === 'string' ? request.title : ''
  const lines = title.split('\n')
  const at = lines.findIndex((line) => line.trim().startsWith(APPROVAL_TITLE))

  const said = (at === -1 ? title : lines.slice(at + 1).join('\n')).trim()

  return said === '' ? null : said
}

/** 标题里那一行 `Allow tool: <name>` 的工具名；认不出就是空串。 */
function approvalToolName(request: UpstreamDialogRequest): string {
  const title = typeof request.title === 'string' ? request.title : ''
  const line = title.split('\n').find((entry) => entry.trim().startsWith(APPROVAL_TITLE))

  return line?.trim().slice(APPROVAL_TITLE.length).trim() ?? ''
}

/** 上游那一行标题的前缀；正本 tools/approval.ts 的 `Allow tool: ${tool.name}`。 */
const APPROVAL_TITLE = 'Allow tool:'

/** 产品那三颗按钮里，「批准」落到哪一颗。 */
const APPROVE = APPROVAL_OPTIONS[0]

/** 产品那三颗按钮的取值域，与 crates/agent-client 的 permission.rs 逐字对应。 */
export interface ApprovalAnswer {
  readonly decision: 'approved' | 'rejected' | 'cancelled'
  readonly scope?: 'session'
}

/**
 * 等答复的那张表。
 *
 * 上游的请求 id 由我们签发（它是我们这条线上的号），答复按同一个号回来。
 *
 * 开门与关门都报给观察者：屏幕要画「有一件事在等人答」，而那条事实只能从这张表里
 * 知道（AGENTS.md §5「成形与投递两段式」：占号、登记在锁内，播发在外）。
 */
export class DialogDesk {
  readonly #waiting = new Map<string, (response: unknown) => void>()
  readonly #emit: (frame: Record<string, unknown>) => void
  readonly #observe: ((event: DialogLifecycle) => void) | undefined
  #next = 0

  /** 出口由构造方给：桥把它写成一行到 stdout。 */
  constructor(
    emit: (frame: Record<string, unknown>) => void,
    observe?: (event: DialogLifecycle) => void,
  ) {
    this.#emit = emit
    this.#observe = observe
  }

  /** 问一次人，等一个答复；超时与中止由调用方给。 */
  ask(request: Record<string, unknown>, options?: ExtensionUIDialogOptions): Promise<unknown> {
    const id = `d${++this.#next}`
    const shaped = request as UpstreamDialogRequest
    const signal = options?.signal

    /*
     * 已经作废的那一次压根不问人。
     *
     * `addEventListener('abort')` 只在 abort **之后**触发：信号若在我们登记之前就已中止，
     * 监听器永远不会响，那一次对话框就永远留在等人答的表里 —— 屏幕上是收不掉的带子，
     * agent 那头也没有人在等。所以先看状态再决定问不问。
     */
    if (signal?.aborted === true) {
      this.#observe?.({ kind: 'aborted', id, request: shaped })

      return Promise.resolve(cancelled(id))
    }

    return new Promise<unknown>((resolve) => {
      /*
       * 唯一的结账点：答复、超时、中止三条路都从这里走。
       *
       * 三条各写一遍会让「Promise 结了但观察者没被告知」成为可能 —— 屏幕因此永远
       * 停着一条没人能答的带子。归一到一处，那种不一致就写不出来了。
       */
      const settle = (response: unknown, cause?: 'timeout' | 'aborted') => {
        if (!this.#waiting.delete(id)) {
          return
        }

        this.#observe?.(
          cause === undefined
            ? { kind: 'settled', id, payload: response as Record<string, unknown> }
            : { kind: cause, id, request: shaped },
        )
        resolve(response)
      }

      this.#waiting.set(id, resolve)

      if (options?.timeout !== undefined && options.timeout > 0) {
        setTimeout(() => settle(cancelled(id), 'timeout'), options.timeout)
      }

      signal?.addEventListener('abort', () => settle(cancelled(id), 'aborted'), { once: true })

      this.#observe?.({ kind: 'opened', id, request: shaped })

      this.#emit({ type: 'extension_ui_request', id, ...request })
    })
  }

  /** 答复到了。认不出的号如实说没有，不假装答上了。 */
  settle(id: string, payload: Record<string, unknown>): void {
    const waiting = this.#waiting.get(id)

    if (waiting === undefined) {
      throw new Error(`no dialog is waiting under ${id}`)
    }

    this.#waiting.delete(id)
    this.#observe?.({ kind: 'settled', id, payload })
    waiting({ type: 'extension_ui_response', id, ...payload })
  }

  /**
   * 把还在等的全部收成取消，交出收了几个。
   *
   * 取消一轮时要用它：上游授权闸门问的那一次 `select` **不带 signal**
   * （extensibility/extensions/wrapper.ts:333），所以点「取消」并不会让那一次对话框
   * 自己作罢。谁都不结它，那次工具调用就永远停在 await 上，而屏幕上那条带子
   * 也永远停在「等你批」—— 这一轮早就取消了，没有人再会来答它。
   *
   * 已答过的不在其中（它们在 `settle` 里就出表了），所以重复调用是安全的。
   */
  closeAll(): number {
    const waiting = [...this.#waiting.keys()]

    if (waiting.length === 0) {
      return 0
    }

    const pending = this.#waiting

    for (const id of waiting) {
      const resolve = pending.get(id)

      if (resolve === undefined) {
        continue
      }

      pending.delete(id)
      this.#observe?.({ kind: 'aborted', id, request: {} })
      resolve(cancelled(id))
    }

    return waiting.length
  }
}

/**
 * 一次对话框的开门与关门。
 *
 * `request` 是开门时那张原样请求（授权闸门要从中读工具名，提问要读题组）；
 * `payload` 是关门时的答复。观察者据此把「在等人答」这条事实播给屏幕。
 */
export type DialogLifecycle =
  | { readonly kind: 'opened'; readonly id: string; readonly request: UpstreamDialogRequest }
  | {
      readonly kind: 'settled'
      readonly id: string
      readonly payload: Record<string, unknown>
    }
  /** 超时与中止都是「没人答」，但归因不同，所以分开报。 */
  | { readonly kind: 'timeout'; readonly id: string; readonly request: UpstreamDialogRequest }
  | { readonly kind: 'aborted'; readonly id: string; readonly request: UpstreamDialogRequest }

function cancelled(id: string): Record<string, unknown> {
  return { type: 'extension_ui_response', id, cancelled: true }
}

/**
 * 把一次答复翻成上游 select 期望的那个标签。
 *
 * `cancelled` 走 undefined：上游把 undefined 当成「没选」，然后按未批准处理 —— 那
 * 正是取消该有的结局（这一轮停了，不是这一句被拒）。
 *
 * 「本次会话都批准」在这一层与「批准」同义：上游这条路只有批准与不批准两颗，
 * 一次 select 只放行这一次。会话级放行是**另一条设置**（`tools.approval.<tool>: allow`），
 * 由 main.ts 的 answerPermission 在答复之前写进 agent 自己的 config —— 上游在
 * `resolveApproval` 里先查用户策略，所以写进去了才真的「本会话都批准」。
 */
export function labelFor(answer: ApprovalAnswer): string | undefined {
  return answer.decision === 'approved' ? APPROVE : undefined
}

/** 上游 select 的选项可能是字符串，也可能是带说明的对象。 */
function labelOf(option: ExtensionUISelectItem): string {
  return typeof option === 'string' ? option : option.label
}

export function createUIContext(desk: DialogDesk): ExtensionUIContext {
  const ui = {
    timeoutStartsOnPresentation: false,

    async select(
      title: string,
      options: ExtensionUISelectItem[],
      dialogOptions?: ExtensionUIDialogOptions,
    ): Promise<string | undefined> {
      const response = (await desk.ask(
        { method: 'select', title, options: options.map(labelOf) },
        dialogOptions,
      )) as { value?: unknown; cancelled?: boolean }

      return response.cancelled === true || typeof response.value !== 'string'
        ? undefined
        : response.value
    },

    async confirm(
      title: string,
      message: string,
      dialogOptions?: ExtensionUIDialogOptions,
    ): Promise<boolean> {
      const response = (await desk.ask({ method: 'confirm', title, message }, dialogOptions)) as {
        confirmed?: unknown
      }

      return response.confirmed === true
    },

    async input(
      title: string,
      placeholder?: string,
      dialogOptions?: ExtensionUIDialogOptions,
    ): Promise<string | undefined> {
      const response = (await desk.ask({ method: 'input', title, placeholder }, dialogOptions)) as {
        value?: unknown
      }

      return typeof response.value === 'string' ? response.value : undefined
    },

    async editor(
      title: string,
      prefill?: string,
      dialogOptions?: ExtensionUIDialogOptions,
    ): Promise<string | undefined> {
      const response = (await desk.ask({ method: 'editor', title, prefill }, dialogOptions)) as {
        value?: unknown
      }

      return typeof response.value === 'string' ? response.value : undefined
    },

    /*
     * ask 工具的题目走这里：形状比 select 宽（一组题、可多选）。
     *
     * 题目本身在这里折成产品形状（questions.ts），答复再折回上游要的 results ——
     * 上游那份载荷（选项只有标签、还带 preview / recommended）不出这条边界。
     * `value` 缺席即撤下整组，上游把 undefined 读成取消（tools/ask.ts:946-949）。
     */
    async askDialog(
      questions: ExtensionAskDialogQuestion[],
      dialogOptions?: ExtensionUIDialogOptions,
    ): Promise<ExtensionAskDialogResult | undefined> {
      const response = (await desk.ask({ method: 'ask', questions }, dialogOptions)) as {
        value?: unknown
      }

      return response.value as ExtensionAskDialogResult | undefined
    },

    /* 无终端宿主本来就没有的面：与上游 RPC 模式同一套处理，能忽略的忽略。 */
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    setEditorText: () => {},
    pasteToEditor: () => {},
    getEditorText: () => '',
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    custom: async () => undefined as never,
  }

  /*
   * 一个 cast，而且窄：闸门那条路只走 select / confirm，其余是交互式 TUI 的面
   * （主题、组件），嵌入方没有也不该有。逐个补空实现会把「这里没有终端」说成
   * 「这里有，只是都是空的」—— 上游真调到它们时应当看见拒绝，而不是假成功。
   */
  return ui as unknown as ExtensionUIContext
}
