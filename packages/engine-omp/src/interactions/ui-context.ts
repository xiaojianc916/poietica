import type {
  AutocompleteProviderFactory,
  ExtensionAskDialogQuestion,
  ExtensionAskDialogResult,
  ExtensionCustomOptions,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionUISelectItem,
  ExtensionUiComponent,
  ExtensionUiComponentFactory,
  ExtensionWidgetContent,
  ExtensionWidgetOptions,
  TerminalInputHandler,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types'
import { getExtensionUISelectOptionLabel } from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types'
import type { EditorTheme, TUI } from '@oh-my-pi/pi-tui'
import type { KeybindingsManager } from '@oh-my-pi/pi-tui/app-keybindings'
import type { CustomEditor } from '@oh-my-pi/pi-tui/prompt/custom-editor'
import {
  setTheme as applyTheme,
  theme as currentTheme,
  ensureThemeSync,
  getAvailableThemesWithPaths,
  getThemeByName,
  setThemeInstance,
  type Theme,
} from '@oh-my-pi/pi-tui/theme'
import type { Interaction, InteractionAnswer } from '@poietica/engine'
import { approvalGrantsSession, approvalInteraction, approvalLabelOf, approvalOf } from './approval'
import type { AskOptions, InteractionBroker } from './broker'
import { askQuestionsOf, askResultOf, questionInteraction } from './questions'

/**
 * omp 的 ExtensionUIContext 实现（12 页 §8.3、04 页 §3.12）。
 *
 * omp 的授权闸门与提问都经这个接口找人：没有它（或者不完整）时闸门 fail closed，
 * 非 yolo 模式下每一次 write/exec 都抛「requires approval but no interactive UI available」。
 * 所以这不是加功能，是让这条路不堵死。
 *
 * 只有问得出人的那四个对话框（select / confirm / input / editor）与 askDialog 接到 broker 上；
 * 其余成员是交互式 TUI 的面（主题、控件、状态栏），嵌入方没有也不该有 —— 但**必须逐个实现**：
 * 用 `as unknown as ExtensionUIContext` 强转会让 omp 升级时新增的成员静默缺失（12 页 §8.3）。
 */
export interface UiContextHooks {
  /** 会话级放行：approve 且 scope 为 session 时调用。写的是会话 overlay，不落盘、不串会话 */
  readonly grantTool?: (tool: string) => void
}

/** 造一个接到 broker 上的 uiContext。传入的 hooks 只影响「批准并记住」这一条路 */
export function createUiContext(broker: InteractionBroker, hooks: UiContextHooks = {}): ExtensionUIContext {
  return new OmpUiContext(broker, hooks)
}

class OmpUiContext implements ExtensionUIContext {
  /**
   * 倒计时由我们自己按注入的时钟算（broker 的 timeoutMs），而对话框是**立刻**呈现的，
   * 所以对 omp 说的这句话是真话；tools/ask.ts:294 因此不再叠一个回退计时器。
   */
  readonly timeoutStartsOnPresentation = false

  constructor(
    private readonly broker: InteractionBroker,
    private readonly hooks: UiContextHooks,
  ) {}

  async select(
    title: string,
    options: ExtensionUISelectItem[],
    dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    /* 选项可以是字符串也可以是带说明的对象：标签只能问 omp 要，不能自己拼（SDK 参考 §H） */
    const labels = options.map((option) => getExtensionUISelectOptionLabel(option))
    const approval = approvalOf(title, labels)

    if (approval !== null) {
      return await this.broker.ask(
        approvalInteraction(approval),
        (answer) => {
          // 批准并选了「本次会话都放行」：把这一格写进会话设置；答复照旧是那颗按钮的字面量
          if (approvalGrantsSession(answer)) this.hooks.grantTool?.(approval.tool)
          return approvalLabelOf(answer)
        },
        askOptions(dialogOptions),
      )
    }

    return await this.broker.ask({ kind: 'select', title, options: labels }, selectValueOf, askOptions(dialogOptions))
  }

  async confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
    /* 没答（超时 / 中止 / cancelAll）按 false：确认类问话的缺席只能是不确认 */
    return await this.broker.ask({ kind: 'confirm', title, message }, confirmValueOf, askOptions(dialogOptions))
  }

  async input(
    title: string,
    placeholder?: string,
    dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    return await this.broker.ask(
      { kind: 'input', title, placeholder: placeholder ?? null, multiline: false },
      inputValueOf,
      askOptions(dialogOptions),
    )
  }

  async editor(
    title: string,
    prefill?: string,
    dialogOptions?: ExtensionUIDialogOptions,
    _editorOptions?: { promptStyle?: boolean },
  ): Promise<string | undefined> {
    /* 多行与单行是同一个交互的两支（multiline 决定 UI 画几行编辑器） */
    return await this.broker.ask(
      { kind: 'input', title, placeholder: prefill ?? null, multiline: true },
      inputValueOf,
      askOptions(dialogOptions),
    )
  }

  async askDialog(
    questions: ExtensionAskDialogQuestion[],
    dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<ExtensionAskDialogResult | undefined> {
    const asked = askQuestionsOf(questions)

    /*
     * 一道题都认不出：画不出来，但**不能就这么算了** —— askDialog 的 Promise 还挂着，
     * 人没有可答的东西，模型会永远等下去。如实收成取消（omp 把 undefined 读成「用户取消」，
     * tools/ask.ts:786-789），那一轮因此停在一个说得清的地方，而不是挂死。
     */
    if (asked.length === 0) return undefined

    const answer = await this.broker.ask(questionInteraction(asked), askOptions(dialogOptions))
    if (answer.kind !== 'question') return undefined
    return askResultOf(asked, { answers: answer.answers })
  }

  /* —— 交互式 TUI 的面：嵌入方没有，逐个如实空实现（不是「有，只是都是空的」） —— */

  notify(_message: string, _type?: 'info' | 'warning' | 'error'): void {}

  onTerminalInput(_handler: TerminalInputHandler): () => void {
    return () => {}
  }

  setStatus(_key: string, _text: string | undefined): void {}

  setWorkingMessage(_message?: string): void {}

  setWidget(_key: string, _content: ExtensionWidgetContent, _options?: ExtensionWidgetOptions): void {}

  setFooter(_factory: ExtensionUiComponentFactory | undefined): void {}

  setHeader(_factory: ExtensionUiComponentFactory | undefined): void {}

  setTitle(_title: string): void {}

  async custom<T>(
    _factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
    _options?: ExtensionCustomOptions,
  ): Promise<T> {
    /*
     * 与 PI_NO_PTY=1 配合：这个宿主没有终端组件层，没有东西可渲染，也没有键盘焦点可交。
     * 返回 undefined 而不是 reject：omp 的调用方把 undefined 读成「没拿到结果」，
     * 抛出去会在它的事件循环里变成一条 runtime error（12 页 §8.3）。
     */
    return undefined as T
  }

  setEditorText(_text: string): void {}

  pasteToEditor(_text: string): void {}

  /** 没有输入编辑器，如实返回空串（接口要的是 string，不给 null） */
  getEditorText(): string {
    return ''
  }

  addAutocompleteProvider(_factory: AutocompleteProviderFactory): void {}

  setEditorComponent(
    _factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
  ): void {}

  /** 主题是全局单例：委托 @oh-my-pi/pi-tui/theme，自己不存第二份 */
  get theme(): Theme {
    // 主题单例在第一次 initThemeSync 之前是 undefined：取用之前先确保它已被初始化
    ensureThemeSync()
    return currentTheme
  }

  async getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
    return await getAvailableThemesWithPaths()
  }

  async getTheme(name: string): Promise<Theme | undefined> {
    return await getThemeByName(name)
  }

  async setTheme(theme: string | Theme): Promise<{ success: boolean; error?: string }> {
    if (typeof theme !== 'string') {
      setThemeInstance(theme)
      return { success: true }
    }
    return await applyTheme(theme)
  }

  /** 工具输出展开是终端交互的面；没有终端，如实说没有展开 */
  getToolsExpanded(): boolean {
    return false
  }

  setToolsExpanded(_expanded: boolean): void {}
}

/** 普通 select 的答复 → 选中的标签；超时 / 中止是 undefined（omp 把它当「没选」） */
function selectValueOf(answer: InteractionAnswer): string | undefined {
  return answer.kind === 'select' ? (answer.value ?? undefined) : undefined
}

/** confirm 的答复 → 布尔；dismiss 与形状不符一律 false */
function confirmValueOf(answer: InteractionAnswer): boolean {
  return answer.kind === 'confirm' && answer.value
}

/** input / editor 的答复 → 字符串；dismiss 与形状不符一律 undefined */
function inputValueOf(answer: InteractionAnswer): string | undefined {
  return answer.kind === 'input' ? (answer.value ?? undefined) : undefined
}

/** dialogOptions.timeout / signal 原样交给 broker（12 页 §8.3 的要点） */
function askOptions(dialogOptions?: ExtensionUIDialogOptions): AskOptions {
  return {
    ...(dialogOptions?.timeout === undefined ? {} : { timeoutMs: dialogOptions.timeout }),
    ...(dialogOptions?.signal === undefined ? {} : { signal: dialogOptions.signal }),
  }
}

/** 本文件在公开签名里用到的那一格交互类型（调用方按需取用，不必回 engine 再导一次） */
export type UiInteraction = Interaction
