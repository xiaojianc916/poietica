import type { AgentPromptResult } from '@poietica/contract/conversation'
import type { ThreadId } from './address'
import type { ApprovalAnswer } from './permission'
import type { QuestionResponse } from './question'
import type { TranscriptPort } from './transcript'

export interface PromptAsset {
  readonly sessionToken: string
  readonly assetToken: string
  readonly filename: string
  /** image：进内存注册表走预览；file：暂存在原生侧的通用文件，发 file part。 */
  readonly kind: 'image' | 'file'
}

export interface PromptSkill {
  readonly name: string
  readonly args?: string | undefined
}

export interface PromptConfiguration {
  readonly id: string
  readonly value: string
}

export interface AgentPromptRequest {
  readonly threadId: ThreadId
  readonly text: string
  readonly configuration: readonly PromptConfiguration[]
  readonly assets: readonly PromptAsset[]
  readonly skills: readonly PromptSkill[]
}

export type AgentPromptHandle = Readonly<AgentPromptResult>

export interface AgentSessionPort {
  readonly transcript: TranscriptPort
  readonly prompt: (request: AgentPromptRequest) => Promise<AgentPromptHandle>
  readonly cancel: (threadId: ThreadId) => Promise<void>
  /* 队列归 agent，号由 prompt.queued 帧带来；这一侧不留副本。 */
  readonly steer: (threadId: ThreadId, promptIds: readonly string[]) => Promise<void>
  readonly abortPrompt: (threadId: ThreadId, promptId: string) => Promise<void>
  readonly resolvePermission: (requestId: string, answer: ApprovalAnswer) => Promise<void>
  readonly answerQuestions: (response: QuestionResponse) => Promise<void>
  readonly dismissQuestions: (questionId: string) => Promise<void>
}
