import type {
  PermissionItem,
  TimelineState,
  ToolCallTimelineItem,
  Transcript,
} from '@poietica/agent'
import { pendingPermission, pendingPermissionCall, pendingPermissionCount } from '@poietica/agent'
import type { AgentSessionPort, ChatStatus, PromptAsset } from '@poietica/agent-contract'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useTranscripts } from './transcripts-context'

/*
 * 界面从 store 里读什么，以什么粒度读。
 *
 * store 每一拍都交出一个新的 Transcript 对象，所以「一条订阅读整份」等于让唯一的
 * 订阅者在流式期间以帧率重渲染，连同它挂着的整个输入框子树：草稿、附件、模型选择器、
 * 发送键，没有一个与转录内容有关。
 *
 * React 对 useSyncExternalStore 的保证是：快照 Object.is 相等就不重渲染。所以正确的
 * 形状不是「一条订阅 + 一堆 memo 去挡」，而是按字段各订一条，每条都交出一个能稳定
 * 比较的东西：
 *
 *   status     字符串字面量
 *   restoring  布尔
 *   timeline   转录本身 —— 只有真正画转录的那棵子树订它
 *   pending    条目引用，reducer 只在它被答复时才换
 *
 * 这不是四份数据，是同一份状态的四个投影，共用同一个订阅入口。
 */

export interface AssistantSubmission {
  readonly text: string
  /**
   * 这一句带的图片，已经在原生的交付注册表里。
   *
   * 不是 File：字节在用户放手的那一刻就入了库（拖放与文件对话框交路径，剪贴板交
   * 一次 base64），所以发送这条路上再没有任何要读、要编码、要等的东西。
   */
  readonly assets: readonly PromptAsset[]
}

export interface AssistantSessionOptions {
  /**
   * Thread this surface is bound to, or null before it has become one.
   *
   * 入口那一格还不是任何一条对话：没有可回放的记录，也没有名字。
   */
  readonly endpoint: string | null
  /**
   * Acquires the conversation this surface is about to become.
   *
   * 只在第一句话时问一次。要不到就没有地方可送，这一句因此失败，
   * 而不是发往一个不存在的对话。
   */
  readonly identify?: (() => Promise<string | null>) | undefined
  /**
   * What the user just said, before the agent is asked anything.
   *
   * The conversation list names a conversation from its first message,
   * and the list is not this hook to keep, so the fact is handed out
   * rather than reached for.
   */
  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined
  readonly session?: AgentSessionPort | undefined
}

export interface AssistantSession {
  /** 这一格现在的键：真对话 id，或入口那一格的草稿键。 */
  readonly key: string
  readonly status: ChatStatus
  readonly send: (submission: AssistantSubmission) => void
  readonly cancel: () => void
  readonly resolvePermission: (requestId: string, optionId: string) => void
  /** True while a conversation is still being fetched. */
  readonly isRestoring: boolean
}

/*
 * 一条订阅，一个投影。
 *
 * project 必须是模块级函数：它进 getSnapshot 的依赖数组，写成内联箭头就等于
 * 每次渲染换一个 getSnapshot，React 会当作快照可能变了。
 */
function useSlice<TValue>(key: string, project: (transcript: Transcript) => TValue): TValue {
  const transcripts = useTranscripts()

  return useSyncExternalStore(
    useCallback((onChange: () => void) => transcripts.subscribe(key, onChange), [transcripts, key]),
    useCallback(() => project(transcripts.read(key)), [transcripts, key, project]),
  )
}

/* 纯 switch，返回字符串字面量：依赖数组的分配与比较比它本身贵。 */
function toChatStatus(status: TimelineState['status']): ChatStatus {
  switch (status) {
    case 'running':
    case 'awaiting_permission':
      return 'streaming'
    case 'failed':
      return 'error'
    default:
      return 'ready'
  }
}

const readStatus = (transcript: Transcript): ChatStatus => toChatStatus(transcript.timeline.status)

const readRestoring = (transcript: Transcript): boolean => transcript.restoring

const readTimeline = (transcript: Transcript): TimelineState => transcript.timeline

/*
 * 待答的那一道：倒扫，走到人说的上一句话为止（pendingPermission）。
 *
 * 代价是这一轮的长度，不是整条对话的长度；而它交回的是转录里那个条目本身，
 * 所以在被答复之前恒是同一个引用 —— 订阅它的界面因此不会因为流式追加而醒。
 */
const readPending = (transcript: Transcript): PermissionItem | undefined =>
  pendingPermission(transcript.timeline)

/* 同一趟扫描的另一格。交出的是数字，所以它比条目引用还稳。 */
const readPendingCount = (transcript: Transcript): number =>
  pendingPermissionCount(transcript.timeline)

export function useAssistantSession({
  endpoint,
  identify,
  onUserMessage,
  session,
}: AssistantSessionOptions): AssistantSession {
  const transcripts = useTranscripts()

  /*
   * 入口那一格也需要一个键。
   *
   * 它还不是任何一条对话，可它已经有转录了 —— 人说的那句话。给它一个草稿键，
   * 真 id 到达时由 store 改名，两个键读到同一份东西。
   */
  const [draft] = useState(transcripts.newDraft)

  const key = endpoint ?? draft

  const status = useSlice(key, readStatus)
  const isRestoring = useSlice(key, readRestoring)

  /*
   * 接上帧流。就这一件事。
   *
   * 条件只剩线路：接不接得上帧流，与这一格现在看着哪条对话无关。入口那一格
   * 也接 —— 它在说第一句话之前就该听着了。
   */
  useEffect(() => {
    if (session === undefined) {
      return
    }

    transcripts.ensure(session)
  }, [session, transcripts])

  /* 说一句话，就是说一句话：附件进门就已经入库，这条路上没有任何要等的东西。 */
  const send = useCallback(
    (submission: AssistantSubmission) => {
      transcripts.send({
        assets: submission.assets,
        endpoint,
        identify,
        key,
        onUserMessage,
        port: session,
        text: submission.text,
      })
    },
    [endpoint, identify, key, onUserMessage, session, transcripts],
  )

  const cancel = useCallback(() => {
    transcripts.cancel(key)
  }, [key, transcripts])

  const resolvePermission = useCallback(
    (requestId: string, optionId: string) => {
      transcripts.resolvePermission(key, requestId, optionId)
    },
    [key, transcripts],
  )

  return { key, status, send, cancel, resolvePermission, isRestoring }
}

/**
 * 转录本身。只有真正画它的那棵子树订这一条。
 *
 * 它是唯一一个以帧率变化的投影，所以它也是唯一一个以帧率重渲染的订阅者 ——
 * 这正是把它单独拎出来的全部理由。
 */
export function useAssistantTimeline(key: string): TimelineState {
  return useSlice(key, readTimeline)
}

/**
 * 这一轮此刻卡在哪一道权限请求上，没有就是 undefined。
 *
 * 交回条目本身：它的身份由 reducer 维护（答复到达时才就地替换那一条），所以
 * 订阅它不会被流式追加打扰。是不是一道「提问」由界面层按方言判，这一层只回答
 * 「有没有人在等」。
 */
export function useAssistantPending(key: string): PermissionItem | undefined {
  return useSlice(key, readPending)
}

/**
 * 这一轮此刻一共有几道权限请求在等。
 *
 * 审批带一次只显示最早那一个，所以它要的不是一叠请求，是一个分母 —— 交出
 * 数组就等于每一帧都换一个新引用，而这一层的全部意义就是不被叫醒。
 */
export function useAssistantPendingCount(key: string): number {
  return useSlice(key, readPendingCount)
}

/* 请求只带一个号，要签字的原文在那条调用上。 */
const readPendingCall = (transcript: Transcript): ToolCallTimelineItem | undefined =>
  pendingPermissionCall(transcript.timeline)

/** 待答请求指向的那次调用；审批带照着它印字。 */
export function useAssistantPendingCall(key: string): ToolCallTimelineItem | undefined {
  return useSlice(key, readPendingCall)
}
