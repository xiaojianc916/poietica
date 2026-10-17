import './composer-actions.css'
import './question-panel.css'

import type { SlashCommand } from '@poietica/engine'
import { memo, type Ref, useMemo } from 'react'
import type { SessionConfigControl } from '../../shared/model/config'
import type { DialogAnswer } from '../../shared/model/dialog'
import type { PlanAnswer } from '../../shared/model/plan'
import type { QuestionResponse } from '../../shared/model/question'
import type { ChatStatus } from '../../shared/model/run'
import type { AgentMcpServer, AgentSkill } from '../../shared/model/toolkit'
import type { SessionUsage } from '../../shared/model/usage'
import type { QuestionTimelineItem } from '../../shared/timeline/timeline-contract'
import type { PromptInputMessage } from '../prompt'
import { AttachmentTray } from './attachment-tray'
import { activePromptConfiguration, ComposerActions, ComposerChips, composerPaletteGroups } from './composer-actions'
import { ContextGauge } from './context-gauge'
import { PermissionPicker, SessionControls } from './controls'
import { DialogPanel } from './dialog-panel'
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

export interface AssistantComposerProps {
  readonly placeholder?: string
  readonly status?: ChatStatus
  /** 缺席时是字段而非消息框：无发送键，Enter 只换行，草稿不被消费。 */
  readonly onSubmit?: ((input: PromptInputMessage) => void) | undefined
  /** 只写一次；此后草稿归 PromptInput。 */
  readonly initialText?: string | undefined
  readonly onChange?: ((text: string) => void) | undefined
  readonly attachments?: boolean | undefined
  readonly onCancel?: (() => void) | undefined
  readonly onContinue?: (() => void) | undefined
  readonly ref?: Ref<PromptInputHandle> | undefined
  readonly skills?: readonly AgentSkill[] | undefined
  readonly mcpServers?: readonly AgentMcpServer[] | undefined
  /** omp 的斜杠命令：草稿敲下行首 `/` 弹出的命令面板；选中执行仍走 onSubmit（收信人按正文认命令） */
  readonly commands?: readonly SlashCommand[] | undefined
  /** 直接执行一句命令（上下文面板的维护动作用它）；缺席时那排按钮不画 */
  readonly onRunCommand?: ((text: string) => void) | undefined
  /** Everything the session (or, before one exists, the agent config) offers. */
  readonly controls: readonly SessionConfigControl[]
  /** 这张表还没被 agent 确认过：画得出内容，但点不动。 */
  readonly controlsPending?: boolean | undefined
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  readonly usage?: SessionUsage | undefined
  /** 非空时输入框长成问答面板，空着就是平常那个 composer。 */
  readonly question?: QuestionTimelineItem | null | undefined
  readonly onAnswerQuestions?: ((response: QuestionResponse) => Promise<void>) | undefined
  readonly onAnswerDialog?: ((interactionId: string, answer: DialogAnswer) => Promise<void>) | undefined
  readonly onDismissQuestions?: ((questionId: string) => Promise<void>) | undefined
  /* 与题组是同一条协议通道的两支：题组把卡内容整个换成面板，审批只在卡顶加一格 —— 它拦的是 agent 的下一步，输入框照常能打字。 */
  readonly approval?: PermissionDockProps | null | undefined
  readonly plan?: PlanDockProps['item'] | null | undefined
  readonly onResolvePlan?: ((requestId: string, answer: PlanAnswer) => void) | undefined
}

/* 只声明这一层真的兑现的那几项：声明了不转发会悄悄吃掉调用方的 ref。 */
type ComposerToolbarProps = Pick<
  AssistantComposerProps,
  | 'commands'
  | 'controls'
  | 'controlsPending'
  | 'onCancel'
  | 'onContinue'
  | 'onRunCommand'
  | 'onSelectControl'
  | 'onSubmit'
  | 'usage'
> & {
  readonly status: ChatStatus
  /** 只用来组装要发出去的东西的那张表；未确认时是空的。 */
  readonly confirmed: readonly SessionConfigControl[]
}

function ComposerToolbar({
  commands,
  confirmed,
  controls,
  controlsPending,
  onCancel,
  onContinue,
  onRunCommand,
  onSelectControl,
  onSubmit,
  status,
  usage,
}: ComposerToolbarProps) {
  /* 这层不订草稿：订在这里，「有没有东西可发」一翻转就要重渲整条工具栏。 */
  return (
    <PromptInputToolbar>
      <PromptInputTools>
        {/* 加号那一侧只回答一个问题：往这一句里加什么。 */}
        <ComposerActions />

        {/* 其它功能贡献的输入框动作（attachments 的回形针）。 */}
        <ComposerContributedActions />

        {/* 批准方式常显：按下发送前唯一还需人确认的事（完全访问那一档不可撤销），
            藏进菜单就得先点开才知道授了多大权；它同时是切换入口，不只是标记。 */}
        <PermissionPicker controls={controls} onSelect={onSelectControl} pending={controlsPending} />

        {/* 未确认时不画：那一枚就是一次下发。 */}
        <ComposerChips controls={confirmed} onSelect={onSelectControl} />
      </PromptInputTools>

      <span className="assistant-toolbar__spacer" />

      {/* 上下文余量在模型选择器左侧：先说这条会话还装得下多少，再说这一句由谁来答。 */}
      <ContextGauge
        busy={status === 'streaming' || status === 'submitted'}
        commands={commands}
        onRunCommand={onRunCommand}
        usage={usage}
      />

      {/* 模型选择器挨着「发」：它说的正是这一句将被谁回答。 */}
      <SessionControls controls={controls} onSelect={onSelectControl} pending={controlsPending} />

      {/* 按钮与 onSubmit 读同一份草稿；字段用法没有发送键。 */}
      {onSubmit === undefined ? null : (
        <PromptInputSubmit onCancel={onCancel} onContinue={onContinue} status={status} />
      )}
    </PromptInputToolbar>
  )
}

/* 有命令可用就在占位字里说一声 `/` 能做什么：这是唯一的入口，不说就没人知道（专业 agent 的输入框都这么写）。 */
function placeholderOf(commands: readonly SlashCommand[] | undefined): string {
  return commands === undefined || commands.length === 0 ? '问我任何问题…' : '问我任何问题，输入 / 使用命令'
}

/* memo 只允许语义状态变化重渲染输入区；流式帧由状态球的稳定投影隔离。 */
export const AssistantComposer = memo(function AssistantComposer({
  approval,
  attachments,
  commands,
  initialText,
  onChange,
  onAnswerDialog,
  onAnswerQuestions,
  onDismissQuestions,
  mcpServers,
  onResolvePlan,
  plan,
  skills,
  placeholder,
  question,
  ref,
  status = 'ready',
  onSubmit,
  ...toolbar
}: AssistantComposerProps) {
  /* 换掉的只是壳里的内容（同一个 form），不是浮层 —— 浮层在滚动、聚焦和 Esc 上处处露馅。分支写在孩子身上：提问支曾漏掉 multiple。 */
  const asking = question != null

  /* 未确认的那张表只用来画，不能拿去组装：那是把「这次也别问」押在旧值上。 */
  const confirmed = toolbar.controlsPending === true ? [] : toolbar.controls

  /* 引用稳定，面板才不会每敲一字重建。 */
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
      {/* 咬在卡的上沿、不在卡里，输入框那张卡一个像素都不改；它与题面板可同时在场 ——
          审批与提问是两条各自的队列。 */}
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
        slashCommands={asking ? undefined : commands}
      >
        {asking && question.dialog !== undefined ? (
          /* 单问（确认 / 单选 / 输入）一张自己的卡；key 同题组：换一问就从空草稿重来。 */
          <DialogPanel
            item={question}
            key={question.questionId}
            onAnswer={onAnswerDialog}
            onDismiss={onDismissQuestions}
          />
        ) : asking ? (
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

              <PromptInputEditor placeholder={placeholder ?? placeholderOf(commands)} />
            </PromptInputBody>

            <ComposerToolbar
              commands={commands}
              confirmed={confirmed}
              onSubmit={onSubmit}
              status={status}
              {...toolbar}
            />
          </>
        )}
      </PromptInput>
    </>
  )
})
