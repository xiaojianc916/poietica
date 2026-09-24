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
 */
export class DialogDesk {
  readonly #waiting = new Map<string, (response: unknown) => void>()
  readonly #emit: (frame: Record<string, unknown>) => void
  #next = 0

  /** 出口由构造方给：桥把它写成一行到 stdout。 */
  constructor(emit: (frame: Record<string, unknown>) => void) {
    this.#emit = emit
  }

  /** 问一次人，等一个答复；超时与中止由调用方给。 */
  ask(request: Record<string, unknown>, options?: ExtensionUIDialogOptions): Promise<unknown> {
    const id = `d${++this.#next}`

    return new Promise<unknown>((resolve) => {
      const settle = (response: unknown) => {
        if (this.#waiting.delete(id)) {
          resolve(response)
        }
      }

      this.#waiting.set(id, resolve)

      if (options?.timeout !== undefined && options.timeout > 0) {
        setTimeout(() => settle(cancelled(id)), options.timeout)
      }

      options?.signal?.addEventListener('abort', () => settle(cancelled(id)), { once: true })

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
    waiting({ type: 'extension_ui_response', id, ...payload })
  }
}

function cancelled(id: string): Record<string, unknown> {
  return { type: 'extension_ui_response', id, cancelled: true }
}

/**
 * 把一次答复翻成上游 select 期望的那个标签。
 *
 * `cancelled` 走 undefined：上游把 undefined 当成「没选」，然后按未批准处理 —— 那
 * 正是取消该有的结局（这一轮停了，不是这一句被拒）。
 *
 * 上游这条路只有批准与不批准两颗，所以「本次会话都批准」在这一层与「批准」同义：
 * 它仍然只放行这一次。要真正做到会话级放行得走 `tools.approval.<tool>: allow`
 * 那条设置（写进 config.yaml），那是另一件活 —— 界面照旧画三颗，语义如实窄一档。
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
     * ask 工具的题目走这里。它不是授权，形状比 select 宽（一组题、可多选），
     * 所以原样交给宿主去画，本层不解释它的字段。
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
