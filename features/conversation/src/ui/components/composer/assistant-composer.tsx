import './composer-actions.css'
import './question-panel.css'

import { memo, type Ref, useMemo } from 'react'
import type { SessionConfigControl } from '../../agent/config'
import type { PlanAnswer } from '../../agent/plan'
import type { QuestionResponse } from '../../agent/question'
import type { ChatStatus } from '../../agent/run'
import type { AgentMcpServer, AgentSkill } from '../../agent/toolkit'
import type { SessionUsage } from '../../agent/usage'
import type { PromptInputMessage } from '../../composer/prompt'
import type { QuestionTimelineItem } from '../../timeline/timeline-contract'
import { AttachmentTray } from './attachment-tray'
import { activePromptConfiguration, ComposerActions, ComposerChips, composerPaletteGroups } from './composer-actions'
import { ContextGauge } from './context-gauge'
import { PermissionPicker, SessionControls } from './controls'
import { PermissionDock, type PermissionDockProps } from './permission-dock'
import { PlanDock, type PlanDockProps } from './plan-dock'
import type { PromptInputHandle } from './prompt-input'
import {
  ComposerContributedActions,
  PromptInput,
  PromptInputBody,
  PromptInputEditor,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
} from './prompt-input'
import { QuestionPanel } from './question-panel'

/*
 * The composer, declared rather than driven: no state, no effects. The draft, the
 * attachments, the focus and the file picker belong to PromptInput, the element
 * they are actually part of.
 */

export interface AssistantComposerProps {
  readonly placeholder?: string
  readonly status?: ChatStatus
  /** 这一句发出去做什么。缺席时是字段而非消息框：无发送键，Enter 只换行，草稿不被消费（自动化编辑器的提交键在页头，不在卡里）。 */
  readonly onSubmit?: ((input: PromptInputMessage) => void) | undefined
  /** 挂载时先写进编辑器的正文。此后草稿归编辑器。 */
  readonly initialText?: string | undefined
  /** 草稿正文变了。字段用法靠它把正文读回去。 */
  readonly onChange?: ((text: string) => void) | undefined
  /** 这一格收不收文件。收不了就不画面板里「添加文件」那一行。 */
  readonly attachments?: boolean | undefined
  readonly onCancel?: (() => void) | undefined
  /** 中断后发送一条可见的继续消息。空草稿时那颗键就是它。 */
  readonly onContinue?: (() => void) | undefined
  /** How the surface writes a starter into the draft it does not own. */
  readonly ref?: Ref<PromptInputHandle> | undefined
  /** 这条会话能用的技能，由 kap 报。 */
  readonly skills?: readonly AgentSkill[] | undefined
  /** Kimi 检测到的 MCP server。 */
  readonly mcpServers?: readonly AgentMcpServer[] | undefined
  /** Everything the session (or, before one exists, the agent config) offers. */
  readonly controls: readonly SessionConfigControl[]
  /** 这张表还没被 agent 确认过：画得出内容，但点不动。 */
  readonly controlsPending?: boolean | undefined
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  /** 这条会话最近报的上下文用量。缺席就不画那颗胶囊。 */
  readonly usage?: SessionUsage | undefined
  /** 待答的那一组题。非空时输入框不再是输入框：它自己长成问答面板；空着就是平常那个 composer。 */
  readonly question?: QuestionTimelineItem | null | undefined
  /** 面板交出整组答复时走这里。 */
  readonly onAnswerQuestions?: ((response: QuestionResponse) => Promise<void>) | undefined
  /** 人撤下整组题时走这里。 */
  readonly onDismissQuestions?: ((questionId: string) => Promise<void>) | undefined
  /**
   * 待答的那一次审批。与题组是同一条协议通道的两支、同一张卡上的两处：题组把卡的内容
   * 整个换成面板，审批只在卡顶加一格 —— 它拦的是 agent 的下一步而非人的下一句，输入框
   * 照常能打字。收的是那一格整副入参而非三个 prop：这层只摆进卡里，类型即它的 props。
   */
  readonly approval?: PermissionDockProps | null | undefined
  readonly plan?: PlanDockProps['item'] | null | undefined
  readonly onResolvePlan?: ((requestId: string, answer: PlanAnswer) => void) | undefined
}

/*
 * 只声明这一层真的兑现的那几项：类型邀请调用方传、实现静默丢掉是缺陷 —— ref 成为
 * 普通 prop 后更硬，声明了却不转发会悄悄吃掉调用方的 ref。
 */
type ComposerToolbarProps = Pick<
  AssistantComposerProps,
  'controls' | 'controlsPending' | 'onCancel' | 'onContinue' | 'onSelectControl' | 'onSubmit' | 'usage'
> & {
  readonly status: ChatStatus
  /** 只用来组装要发出去的东西的那张表；未确认时是空的。见 AssistantComposer。 */
  readonly confirmed: readonly SessionConfigControl[]
}

function ComposerToolbar({
  confirmed,
  controls,
  controlsPending,
  onCancel,
  onContinue,
  onSelectControl,
  onSubmit,
  status,
  usage,
}: ComposerToolbarProps) {
  /*
   * 这一层不问草稿任何事：「有没有东西可发」由 PromptInputSubmit 自己订 —— 它是唯一
   * 用到那两个布尔的节点；订在这里，翻转一次就要重渲整条工具栏。于是这层无状态、
   * 无 hook、无副作用：纯粹是一次声明。
   */
  return (
    <PromptInputToolbar>
      <PromptInputTools>
        {/* 加号那一侧只回答一个问题:往这一句里加什么。面板归输入框。 */}
        <ComposerActions />

        {/* 其它功能贡献的输入框动作（attachments 的回形针）。 */}
        <ComposerContributedActions />

        {/*
          批准方式是一颗常显的胶囊，不是菜单里的一行：它说的是「这一句将被怎么执行」，
          按下发送前唯一还需人确认的事（完全访问那一档不可撤销），藏进菜单就得先点开
          才知道授了多大权。它同时是切换入口 —— 一颗只能「摘掉」的标记不是控件。
        */}
        <PermissionPicker controls={controls} onSelect={onSelectControl} pending={controlsPending} />

        {/* 这一句处在哪个模式，以及摘掉它的地方。未确认时不画：那一枚就是一次下发。 */}
        <ComposerChips controls={confirmed} onSelect={onSelectControl} />
      </PromptInputTools>

      <span className="assistant-toolbar__spacer" />

      {/* 上下文余量在模型选择器左侧：先说这条会话还装得下多少，再说这一句由谁来答。 */}
      <ContextGauge usage={usage} />

      {/* 模型选择器挨着「发」：它说的正是这一句将被谁回答。 */}
      <SessionControls controls={controls} onSelect={onSelectControl} pending={controlsPending} />

      {/* 判据同源。「有没有东西可发」现在只从 PromptInput 自己那份草稿读，
          按钮与 onSubmit 看的是同一个所有者。字段用法没有发送键。 */}
      {onSubmit === undefined ? null : (
        <PromptInputSubmit onCancel={onCancel} onContinue={onContinue} status={status} />
      )}
    </PromptInputToolbar>
  )
}

/* memo 只允许语义状态变化重渲染输入区；流式帧由状态球的稳定投影隔离。 */
export const AssistantComposer = memo(function AssistantComposer({
  approval,
  attachments,
  initialText,
  onChange,
  onAnswerQuestions,
  onDismissQuestions,
  mcpServers,
  onResolvePlan,
  plan,
  skills,
  placeholder = '问我任何问题…',
  question,
  ref,
  status = 'ready',
  onSubmit,
  ...toolbar
}: AssistantComposerProps) {
  /*
   * 有题在等，输入框就不是输入框了：换掉的只是壳里内容（仍是同一个 PromptInput、
   * 同一个 form），不是有个东西浮在上面 —— 浮层会在滚动、聚焦和 Esc 上处处露馅。
   * 提问期间没有自由输入这回事，textarea 与工具栏一并让位。分支在孩子身上而非两个
   * return 各写一遍 <PromptInput>：那样提问支曾漏掉 multiple，而 multiple 转假时
   * addAssets 的第一件事就是把已攒的整批丢掉。
   */
  const asking = question != null

  /*
   * 未确认的那张表只用来画，不组装任何要发出去的东西：它答的是「上一次是什么样」，
   * 而摊平的 configuration 跟着 prompt 发出去、面板模式行往草稿写待提交配置、模式
   * chip 点一下就是一次 set_config —— 拿可能早已变了的表去组装，等于把「这次也别问」
   * 押在旧值上。
   */
  const confirmed = toolbar.controlsPending === true ? [] : toolbar.controls

  /* agent 报的选择器与技能，摊平一次交给输入框。引用稳定，面板才不会每敲一字重建。 */
  const configuration = useMemo(() => activePromptConfiguration(confirmed), [confirmed])

  const groups = useMemo(
    () =>
      composerPaletteGroups({
        controls: confirmed,
        mcpServers: mcpServers ?? [],
        onSelectControl: toolbar.onSelectControl,
        skills: skills ?? [],
      }),
    [confirmed, mcpServers, skills, toolbar.onSelectControl],
  )

  return (
    <>
      {/*
        审批那一格咬在卡的上沿，不在卡里：自己画上半张脸，下沿多出一个圆角的量、被卡
        整个盖住（见 permission-dock.css），输入框那张卡一个像素都不改。它与题面板可
        同时在场 —— 审批与提问是两条各自的队列（见 timeline-queries），谁也不压谁。
      */}
      {approval == null ? null : <PermissionDock {...approval} />}
      {plan == null ? null : <PlanDock item={plan} onResolve={onResolvePlan ?? (() => undefined)} />}

      <PromptInput
        attachments={attachments}
        className={asking ? 'assistant-prompt-input--question' : undefined}
        configuration={configuration}
        groups={groups}
        initialText={initialText}
        multiple
        onChange={onChange}
        onSubmit={onSubmit}
        ref={ref}
      >
        {asking ? (
          /* 一组题一个面板：换题组就从第一题、空草稿、未交出重新开始 —— key 的用处，不是加 effect 复位 state。 */
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

            <ComposerToolbar confirmed={confirmed} onSubmit={onSubmit} status={status} {...toolbar} />
          </>
        )}
      </PromptInput>
    </>
  )
})
