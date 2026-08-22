import type {
  PermissionItem,
  QuestionTimelineItem,
  TimelineState,
  ToolCallTimelineItem,
  Transcript,
} from '@poietica/agent'
import {
  describeFailure,
  pendingPermission,
  pendingPermissionCall,
  pendingPermissionCount,
  pendingQuestion,
  runningDelegations,
} from '@poietica/agent'
import type {
  AgentSessionPort,
  ApprovalAnswer,
  ApprovalScope,
  ChatStatus,
  FrameCursor,
  PromptAsset,
  PromptConfiguration,
  PromptSkill,
  QuestionResponse,
} from '@poietica/agent-contract'
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
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]
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
  readonly resolvePermission: (
    requestId: string,
    decision: ApprovalAnswer,
    scope?: ApprovalScope,
  ) => void
  /** 答掉一整组题。答复形状就是协议自己的 QuestionResponse，不经权限请求。 */
  readonly answerQuestions: (response: QuestionResponse) => void
  /** 撤下一整组题。 */
  readonly dismissQuestions: (questionId: string) => void
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

/* 没有会话可送时记进转录的那句话。入口那一格本来就没有会话，而题组不会出现在那里。 */
const NO_SESSION = '这个界面还没有接上助手会话，答复没有送出去。'

/* 纯 switch，返回字符串字面量：依赖数组的分配与比较比它本身贵。 */
function toChatStatus(status: TimelineState['status']): ChatStatus {
  switch (status) {
    case 'submitted':
      return 'submitted'
    case 'running':
    case 'awaiting_permission':
    case 'awaiting_question':
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

/* 交出游标本身：它只在读回一页时才换引用，流式追加叫不醒订阅者。 */
const readEarlier = (transcript: Transcript): FrameCursor | null => transcript.earlier

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

/* 待答的那一组题：与待答的审批同一趟倒扫、同一条引用稳定纪律（pendingQuestion）。 */
const readQuestion = (transcript: Transcript): QuestionTimelineItem | undefined =>
  pendingQuestion(transcript.timeline)

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
        configuration: submission.configuration,
        endpoint,
        identify,
        key,
        onUserMessage,
        port: session,
        text: submission.text,
        skills: submission.skills,
      })
    },
    [endpoint, identify, key, onUserMessage, session, transcripts],
  )

  const cancel = useCallback(() => {
    transcripts.cancel(key)
  }, [key, transcripts])

  const resolvePermission = useCallback(
    (requestId: string, decision: ApprovalAnswer, scope?: ApprovalScope) => {
      transcripts.resolvePermission(key, requestId, decision, scope)
    },
    [key, transcripts],
  )

  /*
   * 答复与撤下直走会话端口，不经过 store。
   *
   * 权限答复走 store，是因为它要在转录里就地落一条记录；提问的落账由帧完成 ——
   * questions_resolved 一到，条目自己就结清了，客户端没有第二笔要记的。这里唯一
   * 要兜的是送不出去：失败就地记进转录，与本地事故同一处写法（appendLocalError）。
   */
  const answerQuestions = useCallback(
    (response: QuestionResponse) => {
      if (session === undefined) {
        transcripts.note(key, NO_SESSION)
        return
      }

      try {
        void Promise.resolve(session.answerQuestions(response)).catch((cause: unknown) => {
          transcripts.note(key, describeFailure(cause))
        })
      } catch (cause) {
        transcripts.note(key, describeFailure(cause))
      }
    },
    [key, session, transcripts],
  )

  const dismissQuestions = useCallback(
    (questionId: string) => {
      if (session === undefined) {
        transcripts.note(key, NO_SESSION)
        return
      }

      try {
        void Promise.resolve(session.dismissQuestions(questionId)).catch((cause: unknown) => {
          transcripts.note(key, describeFailure(cause))
        })
      } catch (cause) {
        transcripts.note(key, describeFailure(cause))
      }
    },
    [key, session, transcripts],
  )

  return {
    key,
    status,
    send,
    cancel,
    resolvePermission,
    answerQuestions,
    dismissQuestions,
    isRestoring,
  }
}

/**
 * 顶部到了要不要往前读。
 *
 * 交回 undefined 就是前面没有了 —— 滚动区因此连报都不报，顶部不空转。读一页
 * 要读几趟归 store，这一层只把「到顶了」这句话接上去。
 */
export function useAssistantEarlier(key: string): (() => void) | undefined {
  const transcripts = useTranscripts()
  const earlier = useSlice(key, readEarlier)

  const reachedTop = useCallback(() => {
    transcripts.reachedTop(key)
  }, [key, transcripts])

  return earlier === null ? undefined : reachedTop
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
 * 订阅它不会被流式追加打扰。提问不在这条通道上 —— 它有自己的条目与选择器
 * （useAssistantQuestion）。
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

/**
 * 这一轮此刻挂在哪一组题上，没有就是 undefined。
 *
 * 与 useAssistantPending 同一条引用稳定纪律：交回的是转录里那个条目本身，
 * 结清（resolution 落账）时才换引用，流式追加叫不醒订阅者。
 */
export function useAssistantQuestion(key: string): QuestionTimelineItem | undefined {
  return useSlice(key, readQuestion)
}

/* 请求只带一个号，要签字的原文在那条调用上。 */
const readPendingCall = (transcript: Transcript): ToolCallTimelineItem | undefined =>
  pendingPermissionCall(transcript.timeline)

/** 待答请求指向的那次调用；审批带照着它印字。 */
export function useAssistantPendingCall(key: string): ToolCallTimelineItem | undefined {
  return useSlice(key, readPendingCall)
}

/* 目标与蜂群各交一个原始值：字符串与数字，所以流式追加叫不醒那排胶囊。 */
/** 此刻还在跑的子代理数。 */
export function useAssistantSwarm(key: string): number {
  return useSlice(key, (t) => runningDelegations(t.timeline))
}
