import '../../composer/composer-actions.css'
import './question-panel.css'

import type {
  AgentMcpServer,
  AgentSkill,
  ChatStatus,
  QuestionResponse,
  QuestionTimelineItem,
  SessionConfigControl,
  SessionUsage,
} from '@poietica/conversation'
import { memo, type Ref, useMemo } from 'react'
import { PermissionPicker } from '../../composer/permission-picker'
import { SessionControls } from '../../composer/session-controls'
import { AttachmentTray } from './attachment-tray'
import {
  activePromptConfiguration,
  ComposerActions,
  ComposerChips,
  composerPaletteGroups,
} from './composer-actions'
import { ContextGauge } from './context-gauge'
import { PermissionDock, type PermissionDockProps } from './permission-dock'
import type { PromptInputHandle, PromptInputMessage } from './prompt-input'
import {
  PromptInput,
  PromptInputBody,
  PromptInputEditor,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
} from './prompt-input'
import { QuestionPanel } from './question-panel'

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
  readonly onSubmit: (input: PromptInputMessage) => void
  readonly onCancel?: (() => void) | undefined
  /** 续接被人停下的那一轮。空草稿时那颗键就是它。 */
  readonly onResume?: (() => void) | undefined
  /** How the surface writes a starter into the draft it does not own. */
  readonly ref?: Ref<PromptInputHandle> | undefined
  /** 这条会话能用的技能，由 kap 报。 */
  readonly skills?: readonly AgentSkill[] | undefined
  /** Kimi 检测到的 MCP server。 */
  readonly mcpServers?: readonly AgentMcpServer[] | undefined
  /** Everything the session (or, before one exists, the agent config) offers. */
  readonly controls: readonly SessionConfigControl[]
  readonly controlsFailure?: string | undefined
  /** 读失败之后重新问一次。 */
  readonly onRetryControls?: (() => void) | undefined
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  /** 这条会话最近报的上下文用量。缺席就不画那颗胶囊。 */
  readonly usage?: SessionUsage | undefined
  /**
   * 待答的那一组题。
   *
   * 非空时输入框不再是输入框：它自己长成问答面板。空着就是平常那个 composer，
   * 所以这条 prop 不给也一切照旧。
   */
  readonly question?: QuestionTimelineItem | null | undefined
  /** 面板交出整组答复时走这里。 */
  readonly onAnswerQuestions?: ((response: QuestionResponse) => void) | undefined
  /** 人撤下整组题时走这里。 */
  readonly onDismissQuestions?: ((questionId: string) => void) | undefined
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
  | 'controls'
  | 'controlsFailure'
  | 'onCancel'
  | 'onResume'
  | 'onRetryControls'
  | 'onSelectControl'
  | 'usage'
> & { readonly status: ChatStatus }

function ComposerToolbar({
  controls,
  controlsFailure,
  onCancel,
  onResume,
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

        {/* 这一句处在哪个模式，以及摘掉它的地方。 */}
        <ComposerChips controls={controls} onSelect={onSelectControl} />
      </PromptInputTools>

      <span className="assistant-toolbar__spacer" />

      {/* 上下文余量在模型选择器左侧：先说这条会话还装得下多少，再说这一句由谁来答。 */}
      <ContextGauge usage={usage} />

      {/* 模型选择器挨着「发」：它说的正是这一句将被谁回答。 */}
      <SessionControls
        controls={controls}
        failure={controlsFailure}
        onRetry={onRetryControls}
        onSelect={onSelectControl}
      />

      {/* 判据同源。「有没有东西可发」现在只从 PromptInput 自己那份草稿读，
          按钮与 onSubmit 看的是同一个所有者。 */}
      <PromptInputSubmit onCancel={onCancel} onResume={onResume} status={status} />
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
  onDismissQuestions,
  mcpServers,
  skills,
  placeholder = '问我任何问题…',
  question,
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
   * 整组题的答复，不是一段话，留个能打字的框只会让人以为打了有用。
   *
   * 分支在孩子身上，不在壳身上：一个所有者、一处配置，identity 由结构保证。
   * 两个 return 各写一次 <PromptInput> 的时候，提问那一支漏了 multiple，而
   * multiple 一旦转假，addAssets 的第一件事就是把已经攒着的整批丢掉。
   */
  const asking = question != null

  /* agent 报的选择器与技能，摊平一次交给输入框。引用稳定，面板才不会每敲一字重建。 */
  const configuration = useMemo(
    () => activePromptConfiguration(toolbar.controls),
    [toolbar.controls],
  )

  const groups = useMemo(
    () =>
      composerPaletteGroups({
        controls: toolbar.controls,
        mcpServers: mcpServers ?? [],
        onSelectControl: toolbar.onSelectControl,
        skills: skills ?? [],
      }),
    [mcpServers, skills, toolbar.controls, toolbar.onSelectControl],
  )

  return (
    <>
      {/*
        审批那一格咬在卡的上沿，不在卡里。

        它自己画上半张脸，下沿多出一个圆角的量、被卡整个盖住（见
        permission-dock.css）。输入框那张卡因此一个像素都不改。

        它与题面板可以同时在场：审批与提问是两条各自的队列（见
        timeline-queries），各画各的，谁也不压谁。
      */}
      {approval == null ? null : <PermissionDock {...approval} />}

      <PromptInput
        className={asking ? 'assistant-prompt-input--question' : undefined}
        configuration={configuration}
        groups={groups}
        multiple
        onSubmit={onSubmit}
        ref={ref}
      >
        {asking ? (
          /* 一组题一个面板：换了题组就该从第一题、空草稿、未交出重新开始，而这
             正是 key 的用处，不是再加一个 effect 去复位几个 state。 */
          <QuestionPanel
            item={question}
            key={question.questionId}
            onAnswer={onAnswerQuestions}
            onDismiss={onDismissQuestions}
          />
        ) : (
          <>
            <PromptInputBody>
              <AttachmentTray />

              <PromptInputEditor placeholder={placeholder} />
            </PromptInputBody>

            <ComposerToolbar status={status} {...toolbar} />
          </>
        )}
      </PromptInput>
    </>
  )
})
