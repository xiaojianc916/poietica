import { FeatureScope, useContributions } from '@poietica/ui-kernel'
import { type ReactNode, useMemo } from 'react'
import { composerProviders, workspaceGitProviders } from '../ui-api'
import { AttachmentIntakeContext } from '../ui-api/composer-assets'
import { ComposerDrafts } from './composer/drafts'
import { ComposerDraftsContext } from './composer/drafts-context'
import type { PostureIntent } from './session/configuration/posture-intent'
import { SessionControlsContext } from './session/configuration/session-controls-context'
import { SessionControlsStore } from './session/configuration/session-controls-store'
import type { TranscriptStore } from './timeline/model/transcript-store'
import { TranscriptsContext } from './timeline/model/transcripts-context'
import { DelegateChannelContext } from './timeline/view/delegate-channel-context'

/*
 * 组合根：把组件树要的每个 Context 接上。加号面板那张名册（技能 / MCP）**不在这里造**
 * —— 它属于 extensions，经 `conversation.composerToolkitSources` 贡献点提供，本层只管画。
 */

export interface ConversationProvidersProps {
  readonly children: ReactNode
  readonly transcripts: TranscriptStore
  /** 批准方式的持久意图；两台 store（入口与单条对话）共用同一份。 */
  readonly posture?: PostureIntent | undefined
  readonly onOpenDelegateChannel?: ((agentId: string) => void) | undefined
}

export function ConversationProviders({
  children,
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
  const openDelegate = useMemo(() => onOpenDelegateChannel ?? (() => undefined), [onOpenDelegateChannel])

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
