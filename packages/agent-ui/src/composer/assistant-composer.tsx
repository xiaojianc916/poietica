import './composer-actions.css'
import './question-panel.css'

import type {
  ChatStatus,
  PaletteEntry,
  SessionConfigControl,
  SessionUsage,
} from '@poietica/agent-contract'
import { memo, type Ref, useMemo } from 'react'
import type { QuestionAnswer, QuestionDeck } from '../semantics/ask-user-question'
import type { ComposerAsset } from './attachment-intake'
import { AttachmentTray } from './attachment-tray'
import {
  ComposerActions,
  ComposerModeChip,
  composerModeRows,
  composerPaletteGroups,
  UPCOMING_COMPOSE_ROWS,
} from './composer-actions'
import { ContextGauge } from './context-gauge'
import { PermissionDock, type PermissionDockProps } from './permission-dock'
import { PermissionPicker } from './permission-picker'
import type { PromptInputHandle } from './prompt-input'
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from './prompt-input'
import { QuestionPanel } from './question-panel'
import { SessionControls } from './session-controls'

/*
 * The composer, declared rather than driven.
 *
 * It holds no state and runs no effect. The draft, the attachments, the focus
 * and the file picker all belong to PromptInput, which is the element they are
 * actually part of; reading them back out through the document was how two
 * owners of one textbox got away with it for as long as they did.
 */

export interface AssistantComposerProps {
  readonly placeholder?: string
  readonly status?: ChatStatus
  readonly onSubmit: (input: {
    readonly text: string
    readonly assets: readonly ComposerAsset[]
  }) => void
  readonly onCancel?: (() => void) | undefined
  /** How the surface writes a starter into the draft it does not own. */
  readonly ref?: Ref<PromptInputHandle> | undefined
  /** agent 报来的命令表：面板里技能与命令两组由它长出。 */
  readonly palette?: readonly PaletteEntry[] | undefined
  /** Everything the session (or, before one exists, the agent config) offers. */
  readonly controls: readonly SessionConfigControl[]
  readonly controlsFailure?: string | undefined
  /** 读失败之后重新问一次。 */
  readonly onRetryControls?: (() => void) | undefined
  readonly onSelectControl: (controlId: string, value: string) => void
  /** 这条会话最近报的上下文用量。缺席就不画那颗胶囊。 */
  readonly usage?: SessionUsage | undefined
  /**
   * 待答的题组。
   *
   * 非空时输入框不再是输入框：它自己长成问答面板。空着就是平常那个 composer，
   * 所以这条 prop 不给也一切照旧。
   */
  readonly questionDeck?: QuestionDeck | null | undefined
  /** 面板交出整组答案时走这里 —— 发送与整组跳过是同一个出口，差别写在答案里。 */
  readonly onAnswerQuestions?: ((answers: readonly QuestionAnswer[]) => void) | undefined
  /**
   * 待答的那一次审批。
   *
   * 与题组是同一条协议通道上的两支，也因此是同一张卡上的两处：题组把卡的内容整个
   * 换成面板（答案是对话的一部分），审批只在卡顶加一格（它拦的是 agent 的下一步，
   * 不是人的下一句，所以输入框照常能打字）。空着就是平常那个 composer。
   *
   * 收的是那一格自己的整副入参，不是三个各走各的 prop：这一层不解释它，只负责把它
   * 摆进卡里，所以类型就该是它的 props 本身 —— 少一格、多一格都由编译器说话。
   */
  readonly approval?: PermissionDockProps | null | undefined
}

/*
 * 只声明这一层真的兑现的那几项。
 *
 * 同一条规矩已经在 PromptInputProps 上写过 —— 类型邀请调用方传，实现静默丢掉。
 * ref 成为普通 prop 之后这件事更硬：一个声明了 ref 却不转发的函数组件会把调用方
 * 的 ref 悄悄吃掉。
 */
type ComposerToolbarProps = Pick<
  AssistantComposerProps,
  'controls' | 'controlsFailure' | 'onCancel' | 'onRetryControls' | 'onSelectControl' | 'usage'
> & { readonly status: ChatStatus }

function ComposerToolbar({
  controls,
  controlsFailure,
  onCancel,
  onRetryControls,
  onSelectControl,
  status,
  usage,
}: ComposerToolbarProps) {
  /*
   * 这一层不再问草稿任何事。
   *
   * 「有没有东西可发」由 PromptInputSubmit 自己订 —— 它是唯一用到那两个布尔的
   * 节点。订在这里，翻转一次就要重渲整条工具栏。于是这一层无状态、无 hook、
   * 无副作用：纯粹是一次声明。
   */
  return (
    <PromptInputToolbar>
      <PromptInputTools>
        {/* 加号那一侧只回答一个问题:往这一句里加什么。面板归输入框。 */}
        <ComposerActions />

        {/*
          批准方式是一颗常显的胶囊,不是菜单里的一行。

          它说的是「这一句将被怎么执行」,而那是按下发送之前唯一还需要人确认的事:
          藏进菜单意味着人必须先点开才知道自己此刻授了多大的权,而完全访问那一档是
          不可撤销的。它也因此同时是切换入口 —— 一颗只能"摘掉"的标记不是控件。
        */}
        <PermissionPicker controls={controls} onSelect={onSelectControl} />

        {/* 生效的档位：一颗，摘掉就是切回首档。真相在 agent 那边。 */}
        <ComposerModeChip controls={controls} onSelect={onSelectControl} />
      </PromptInputTools>

      <span className="assistant-toolbar__spacer" />

      {/*
        模型选择器站在右下这一簇，用量指示之前。

        它挨着「发」，因为它说的正是这一句将被谁回答：ChatGPT、Claude、Cursor
        都把它放在发送键这一侧。左下那一簇回答的是另一个问题——往这句话里加
        什么。
      */}
      <SessionControls
        controls={controls}
        failure={controlsFailure}
        onRetry={onRetryControls}
        onSelect={onSelectControl}
      />

      {/*
        上下文余量站在发送键旁边：它说的是这条会话还装得下多少。数字全部由
        agent 报（kap 的 agent.status.updated），组件只做除法 —— Codex 的
        /status、Claude Code 的 context 指示都以 agent 报数为准。
      */}
      <ContextGauge usage={usage} />

      {/* 判据同源。「有没有东西可发」现在只从 PromptInput 自己那份草稿读，
          按钮与 onSubmit 看的是同一个所有者。 */}
      <PromptInputSubmit onCancel={onCancel} status={status} />
    </PromptInputToolbar>
  )
}

/*
 * 记住不重建。
 *
 * 上游的订阅粒度已经收窄，入参也全部引用稳定，这一层浅比较因此几乎总是命中：
 * 一轮对话里它至多重渲两次。
 */
export const AssistantComposer = memo(function AssistantComposer({
  approval,
  onAnswerQuestions,
  palette,
  placeholder = '问我任何问题…',
  questionDeck,
  ref,
  status = 'ready',
  onSubmit,
  ...toolbar
}: AssistantComposerProps) {
  /*
   * 有题在等，输入框就不是输入框了。
   *
   * 换掉的只是壳里的内容：外面仍是同一个 PromptInput、同一个 form、同一层
   * assistant-prompt-input。所以这是输入框自己长成了面板，不是有个东西浮在
   * 它上面——后者会在滚动、聚焦和 Esc 上处处露馅。
   *
   * textarea 和工具栏一并让位。提问期间没有自由输入这回事：agent 那头等的是
   * 一个 optionId，不是一段话，留个能打字的框只会让人以为打了有用。
   *
   * 分支在孩子身上，不在壳身上：一个所有者、一处配置，identity 由结构保证。
   * 两个 return 各写一次 <PromptInput> 的时候，提问那一支漏了 multiple，而
   * multiple 一旦转假，addAssets 的第一件事就是把已经攒着的整批丢掉。
   */
  const asking = questionDeck != null && questionDeck.cards.length > 0

  /* agent 报的选择器与命令，摊平一次交给输入框。引用稳定，面板才不会每敲一字重建。 */
  const groups = useMemo(
    () =>
      composerPaletteGroups({
        controls: toolbar.controls,
        onSelectControl: toolbar.onSelectControl,
        palette: palette ?? [],
      }),
    [palette, toolbar.controls, toolbar.onSelectControl],
  )

  /* 「添加」组里跟在「添加文件」后面的行：生效模式（目前是 Plan），以及未上线的占位行。 */
  const composeRows = useMemo(
    () => [
      ...composerModeRows({
        controls: toolbar.controls,
        onSelectControl: toolbar.onSelectControl,
      }),
      ...UPCOMING_COMPOSE_ROWS,
    ],
    [toolbar.controls, toolbar.onSelectControl],
  )

  return (
    <>
      {/*
        审批那一格咬在卡的上沿，不在卡里。

        它自己画上半张脸，下沿多出一个圆角的量、被卡整个盖住（见
        permission-dock.css）。输入框那张卡因此一个像素都不改。

        它与题面板互斥 —— 两者同源于唯一那个待答请求（见 AssistantSurface 的
        blocked），所以这里不需要再判一次谁压过谁。
      */}
      {approval == null ? null : <PermissionDock {...approval} />}

      <PromptInput
        className={asking ? 'assistant-prompt-input--question' : undefined}
        composeRows={composeRows}
        groups={groups}
        multiple
        onSubmit={onSubmit}
        ref={ref}
      >
        {asking ? (
          /* 一副题组一个面板：换了题组就该从第一题、空答案、未交出重新开始，而这
             正是 key 的用处，不是再加一个 effect 去复位三个 state。 */
          <QuestionPanel
            deck={questionDeck}
            key={questionDeck.toolCallId}
            onAnswer={onAnswerQuestions}
          />
        ) : (
          <>
            <PromptInputBody>
              <AttachmentTray />

              <PromptInputTextarea placeholder={placeholder} />
            </PromptInputBody>

            <ComposerToolbar status={status} {...toolbar} />
          </>
        )}
      </PromptInput>
    </>
  )
})
