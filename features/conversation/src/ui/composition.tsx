import { FeatureScope, useContributions } from '@poietica/ui-kernel'
import { type ReactNode, useMemo } from 'react'
import { composerProviders, workspaceGitProviders } from '../ui-api'
import { AttachmentIntakeContext } from './components/composer/attachment-intake'
import { ComposerDraftsContext } from './components/composer/drafts-context'
import { SessionControlsContext } from './components/configuration/session-controls-context'
import { DelegateChannelContext } from './components/timeline/delegate-channel-context'
import { TranscriptsContext } from './components/transcript/transcripts-context'
import { ComposerDrafts } from './composer/drafts'
import type { PostureIntent } from './configuration/posture-intent'
import { SessionControlsStore } from './configuration/session-controls-store'
import type { TranscriptStore } from './transcript/transcript-store'

/*
 * 组合根（dependency-injection root）：把 legacy 组件树要的每一个 Context 都接上。
 *
 * legacy 里这些实例由 apps/desktop 的 assistant 层造出来下发；新架构里它们属于本功能，
 * 所以装配点搬到这里。**Context 的形制一字未改**（components/*-context.ts 的头注写着为什么）：
 * 换的只是「谁来造实例」，这正是 14 页 §0.3 第 1 条说的「只改依赖方向和数据来源」。
 *
 * 加号面板那张名册（技能 / MCP）**不在这里造**：它由 extensions 经贡献点提供
 * （`conversation.composerToolkitSources`），面板自己用 `useAgentToolkit` 合成 ——
 * 名册属于 extensions，conversation 的这一层只管画。
 */

export interface ConversationProvidersProps {
  readonly children: ReactNode
  readonly transcripts: TranscriptStore
  /**
   * 批准方式的持久意图。两台 store（入口那一格与单条对话）共用同一份：它们各自
   * 按它判「要不要把新会话对齐到用户上次按下的那一档」。
   */
  readonly posture?: PostureIntent | undefined
  /** 打开一条派发通道（子 agent 视图）。P5 还没有通道面板，先交回一个不动的实现。 */
  readonly onOpenDelegateChannel?: ((agentId: string) => void) | undefined
}

export function ConversationProviders({
  children,
  onOpenDelegateChannel,
  posture,
  transcripts,
}: ConversationProvidersProps): ReactNode {
  // 离屏草稿：一格一份，切换对话时把没发出去的内容存回来（legacy 的 ComposerDrafts）
  const drafts = useMemo(() => new ComposerDrafts(), [])
  // 会话可调项：按 threadId 寻址的那张表
  const sessionControls = useMemo(
    () => new SessionControlsStore({ ...(posture === undefined ? {} : { posture }), transcripts }),
    [posture, transcripts],
  )
  const openDelegate = useMemo(() => onOpenDelegateChannel ?? (() => undefined), [onOpenDelegateChannel])

  /*
   * 附件的入库口由 attachments 功能提供（它认识 dialog.pickFiles 与 attachments.importPaths，
   * 而 conversation 不能 import 它）。贡献按 order 从外到内套在树上；一个都没有时留一个
   * null —— 输入框据此退化成「只有正文、没有附件」，不会崩（legacy 也是这个形状）。
   */
  /*
   * Git 事实的提供者（review 贡献）在最外层：它把「当前工作区的分支与改动」交给整棵树，
   * 状态面板那一格与输入框那一行的分支 chip 都从它读 —— 与 composerProviders 同一形制
   * （Order 由贡献方定，这里只按 order 从外到内套）。一个都没有时留一个 null Context，
   * 面板据此整格不画（不是崩）。
   */
  const gitProviders = useContributions(workspaceGitProviders)
  const withGit = gitProviders.reduceRight<ReactNode>(
    (inner, { featureId, item }) => (
      <FeatureScope featureId={featureId}>
        <item.component>{inner}</item.component>
      </FeatureScope>
    ),
    children,
  )

  const providers = useContributions(composerProviders)
  const provided = providers.reduceRight<ReactNode>(
    (inner, { featureId, item }) => (
      <FeatureScope featureId={featureId}>
        <item.component>{inner}</item.component>
      </FeatureScope>
    ),
    withGit,
  )

  return (
    <TranscriptsContext value={transcripts}>
      <ComposerDraftsContext value={drafts}>
        <SessionControlsContext value={sessionControls}>
          <DelegateChannelContext value={openDelegate}>
            <AttachmentIntakeContext value={null}>{provided}</AttachmentIntakeContext>
          </DelegateChannelContext>
        </SessionControlsContext>
      </ComposerDraftsContext>
    </TranscriptsContext>
  )
}
