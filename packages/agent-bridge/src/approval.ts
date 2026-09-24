/*
 * omp 的 uiContext：把它的对话框接到我们这条 stdio 上。
 *
 * 不自己实现对话框语义 —— 上游已经给了一份**无终端宿主**的现成实现
 * （modes/rpc/rpc-mode.ts 的 RpcExtensionUIContext，ACP 模式也走同一套
 * requestRpcDialog），它处理了超时、AbortSignal、取消帧、响应配对这些边界。
 * 这里只做两件事：把上游导出的那几个 request* 帮手接上我们的输出口，把答复
 * 从 Rust 那边喂回来。
 *
 * 授权闸门（extensibility/extensions/wrapper.ts）在没有 UI 时 fail closed：
 * 非 yolo 模式下每一次 write/exec 都会抛「requires approval but no interactive
 * UI available」。所以这不是加功能，是让这条路不堵死。
 */

import type { ExtensionUIContext } from '@oh-my-pi/pi-coding-agent'
import {
  type RpcPendingExtensionRequests,
  requestRpcDialog,
  requestRpcEditor,
  requestRpcSelect,
} from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode'

/*
 * 授权闸门问的那颗按钮。
 *
 * 上游问的就是这两颗（extensibility/extensions/wrapper.ts 的
 * `uiContext.select(safetyPrompt, ["Approve", "Deny"])`，eval prelude 同款）：
 * 我们要落的是「批准」那一颗，答别的或不答都按未批准处理。
 *
 * ACP 那条路上还有四档（PERMISSION_OPTIONS 的 allow_once / allow_always /
 * reject_once / reject_always），但 SDK 这条路走不到那儿 —— 别照 ACP 的表去认。
 * 分类（「这是不是授权」）只有一处，在 Rust 侧：这里只管把答复翻成标签。
 */
const APPROVE = 'Approve'

/** 产品那三颗按钮的取值域，与 crates/agent-client 的 permission.rs 逐字对应。 */
export interface ApprovalAnswer {
  readonly decision: 'approved' | 'rejected' | 'cancelled'
  readonly scope?: 'session'
}

/** 一条待答的对话框请求，形状与上游 RpcExtensionUIRequest 对应。 */
export interface DialogRequest {
  readonly id: string
  readonly method: string
  readonly [key: string]: unknown
}

/**
 * 把一次答复翻成上游 select 期望的那个标签。
 *
 * `cancelled` 走 undefined：上游把 undefined 当成「没选」，然后按未批准处理 —— 那
 * 正是取消该有的结局（这一轮停了，不是这一句被拒）。
 *
 * 上游这条路只有批准与不批准两颗，所以「本次会话都批准」在这一层与「批准」同义：
 * 它仍然只放行这一次。要真正做到会话级放行得走 `tools.approval.<tool>: allow`
 * 那条设置（写进 config.yml），那是另一件活 —— 界面照旧画三颗，语义如实窄一档。
 */
export function labelFor(answer: ApprovalAnswer): string | undefined {
  return answer.decision === 'approved' ? APPROVE : undefined
}

/**
 * 给 SDK 的 uiContext。
 *
 * 对话框走上游的 request* 帮手；输出口由调用方给（桥写 stdout），答复由
 * `settle` 从 Rust 那条命令喂进来。其余（主题、组件、编辑器）是无终端宿主
 * 本来就没有的面，与上游 RPC 模式的处理一致：能忽略的忽略，做不到的如实说。
 */
export function createUIContext(
  pending: RpcPendingExtensionRequests,
  output: (frame: unknown) => void,
): ExtensionUIContext {
  const ui = {
    timeoutStartsOnPresentation: false,

    select: (title: string, options: readonly unknown[], dialogOptions?: unknown) =>
      requestRpcSelect(pending, output, title, options as never, dialogOptions as never),

    confirm: (title: string, message: string, dialogOptions?: unknown) =>
      requestRpcDialog(
        pending,
        output,
        dialogOptions as never,
        false,
        { method: 'confirm', title, message },
        (response: Record<string, unknown>) => response['confirmed'] === true,
      ),

    input: (title: string, placeholder?: string, dialogOptions?: unknown) =>
      requestRpcDialog(
        pending,
        output,
        dialogOptions as never,
        undefined,
        { method: 'input', title, placeholder },
        (response: Record<string, unknown>) =>
          typeof response['value'] === 'string' ? response['value'] : undefined,
      ),

    editor: (title: string, prefill?: string, dialogOptions?: unknown) =>
      requestRpcEditor(pending, output, title, prefill, dialogOptions as never),

    /* 无终端宿主本来就没有的面：与上游 RPC 模式同一套处理。 */
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

  return ui as unknown as ExtensionUIContext
}
