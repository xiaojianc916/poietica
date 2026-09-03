import type { AssistantActivity } from '../session/assistant-activity'

interface AgentEmotionDescriptor {
  readonly id: string
  readonly label: string
}

const AGENT_EMOTION_BY_ACTIVITY = {
  thinking: { id: '30', label: '思考中' },
  receiving: { id: '31', label: '接收任务' },
  working: { id: '32', label: '处理中' },
  completed: { id: '33', label: '任务完成' },
  failed: { id: '34', label: '出错' },
  waiting: { id: '35', label: '等待输入' },
  restoring: { id: '36', label: '联网加载' },
  recalling: { id: '37', label: '复述回忆' },
  restricted: { id: '38', label: '等待授权' },
  replying: { id: '39', label: '输出回复' },
  searching: { id: '40', label: '检索资料' },
  stopped: { id: '41', label: '停止任务' },
} as const satisfies Readonly<Record<AssistantActivity, AgentEmotionDescriptor>>

export type AgentEmotionId = (typeof AGENT_EMOTION_BY_ACTIVITY)[AssistantActivity]['id']
export type AgentEmotion = (typeof AGENT_EMOTION_BY_ACTIVITY)[AssistantActivity]

export function agentEmotion(activity: AssistantActivity): AgentEmotion {
  return AGENT_EMOTION_BY_ACTIVITY[activity]
}
