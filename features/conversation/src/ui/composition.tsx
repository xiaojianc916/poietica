import { type ProseFileLinks, ProseFileLinksContext } from '@poietica/design-system/prose'
import { FeatureScope, useContributions } from '@poietica/ui-kernel'
import { type ReactNode, useMemo } from 'react'
import { composerProviders, fileReferenceOpeners, turnChangesProviders, workspaceGitProviders } from '../ui-api'
import { AttachmentIntakeContext } from './composer/attachment'
import { ComposerDrafts } from './composer/drafts'
import { ComposerDraftsContext } from './composer/drafts-context'
import { type LiveComposers, LiveComposersContext } from './composer/live-composers'
import type { PostureIntent } from './session/configuration/posture-intent'
import { SessionControlsContext } from './session/configuration/session-controls-context'
import { SessionControlsStore } from './session/configuration/session-controls-store'
import type { TranscriptStore } from './timeline/model/transcript-store'
import { TranscriptsContext } from './timeline/model/transcripts-context'
import { type AgentControls, AgentControlsContext } from './timeline/view/agent-controls-context'
import { DelegateChannelContext, type OpenDelegateChannel } from './timeline/view/delegate-channel-context'

/*
 * 组合根：把组件树要的每个 Context 接上。加号面板那张名册（技能 / MCP）**不在这里造**
 * —— 它属于 extensions，经 `conversation.composerToolkitSources` 贡献点提供，本层只管画。
 */

export interface ConversationProvidersProps {
  readonly children: ReactNode
  readonly transcripts: TranscriptStore
  /** 批准方式的持久意图；两台 store（入口与单条对话）共用同一份。 */
  readonly posture?: PostureIntent | undefined
  /** 点子代理（工具卡上的通道、状态面板的「智能体」行）时打开它的通道；缺席即不可开。 */
  readonly onOpenDelegateChannel?: OpenDelegateChannel | undefined
  /** 子代理 / 后台作业的取消与引导出口（ConversationApi 本身即满足）；缺席时这些控件画成不可用。 */
  readonly agentControls?: AgentControls | undefined
  /** 屏幕上正在编辑的输入框登记表（见 composer/live-composers.ts）；缺席就不登记 */
  readonly liveComposers?: LiveComposers | undefined
  /** 正文里的文件链接属于哪条对话、哪个工作区；缺席即「当前前台」（右坞里的子代理、辅助对话）。 */
  readonly fileScope?: FileScope | undefined
}

export interface FileScope {
  readonly threadId: string | null
  readonly workspaceId: string | null
}

/*
 * 正文文件链接的出口：order 最小的那个 fileReferenceOpeners 贡献接手，并带上这一棵树的对话与工作区。
 * 一个贡献都没有时给 null —— 正文据此把文件名画成不可点，而不是画一个点了没反应的链接。
 */
function useFileLinks(scope: FileScope | undefined): ProseFileLinks | null {
  const openers = useContributions(fileReferenceOpeners)
  const threadId = scope?.threadId ?? null
  const workspaceId = scope?.workspaceId ?? null
  return useMemo(() => {
    const opener = [...openers].sort((left, right) => left.item.order - right.item.order)[0]?.item
    if (opener === undefined) return null
    return { open: (ref) => opener.open({ ...ref, threadId, workspaceId }) }
  }, [openers, threadId, workspaceId])
}

export function ConversationProviders({
  agentControls,
  children,
  fileScope,
  liveComposers,
  onOpenDelegateChannel,
  posture,
  transcripts,
}: ConversationProvidersProps): ReactNode {
  // 离屏草稿：一格一份，切换对话时把没发出去的内容存回来
  const drafts = useMemo(() => new ComposerDrafts(), [])
  const sessionControls = useMemo(
    () => new SessionControlsStore({ ...(posture === undefined ? {} : { posture }), transcripts }),
    [posture, transcripts],
  )
  const openDelegate = useMemo<OpenDelegateChannel>(
    () => onOpenDelegateChannel ?? (() => undefined),
    [onOpenDelegateChannel],
  )

  /*
   * 贡献按 order 从外到内套在树上；一个都没有时留一个 null Context —— 输入框据此退化成
   * 「只有正文、没有附件」，面板那一格整格不画，都不是崩。附件入库口由 attachments 提供
   * （它认识 dialog.pickFiles，conversation 不能 import 它）；Git 事实由 review 提供。
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

  /* 每轮回复下方那条文件改动条的事实源，同样由 review 贡献一个 Provider（见 ui-api/turn-changes）。 */
  const changeProviders = useContributions(turnChangesProviders)
  const withChanges = changeProviders.reduceRight<ReactNode>(
    (inner, { featureId, item }) => (
      <FeatureScope featureId={featureId}>
        <item.component>{inner}</item.component>
      </FeatureScope>
    ),
    withGit,
  )

  const fileLinks = useFileLinks(fileScope)
  const providers = useContributions(composerProviders)
  const provided = providers.reduceRight<ReactNode>(
    (inner, { featureId, item }) => (
      <FeatureScope featureId={featureId}>
        <item.component>{inner}</item.component>
      </FeatureScope>
    ),
    withChanges,
  )

  return (
    <TranscriptsContext value={transcripts}>
      <ComposerDraftsContext value={drafts}>
        <SessionControlsContext value={sessionControls}>
          <DelegateChannelContext value={openDelegate}>
            <AgentControlsContext value={agentControls ?? null}>
              <AttachmentIntakeContext value={null}>
                <LiveComposersContext value={liveComposers ?? null}>
                  <ProseFileLinksContext value={fileLinks}>{provided}</ProseFileLinksContext>
                </LiveComposersContext>
              </AttachmentIntakeContext>
            </AgentControlsContext>
          </DelegateChannelContext>
        </SessionControlsContext>
      </ComposerDraftsContext>
    </TranscriptsContext>
  )
}
