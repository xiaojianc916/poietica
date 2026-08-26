import type {
  Interjection,
  PermissionItem,
  QuestionTimelineItem,
  TimelineState,
  ToolCallTimelineItem,
  Transcript,
} from '@poietica/agent'
import {
  activeScope,
  describeFailure,
  InterjectionOutbox,
  inflightPromptId,
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
  PromptAsset,
  PromptConfiguration,
  PromptSkill,
  QuestionResponse,
} from '@poietica/agent-contract'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
  /** Stable conversation identity, minted before this surface mounts. */
  readonly endpoint: string
  /** Persists a newly minted identity before its first prompt. */
  readonly prepare?: (() => Promise<boolean>) | undefined
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
  /** 待插话消息的出账簿：顺序、编辑与释放时机都归它。 */
  readonly outbox: InterjectionOutbox
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
    case 'cancelling':
      return 'cancelling'
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

/* kap 手上那条还没落定的号，至多一个。 */
const readInflight = (transcript: Transcript): string | undefined =>
  inflightPromptId(activeScope(transcript.timeline))

const readRestoring = (transcript: Transcript): boolean => transcript.restoring

const readTimeline = (transcript: Transcript): TimelineState => transcript.timeline

/* 上面还有没有更早的一页。布尔，所以前插与流式追加都叫不醒订阅者。 */
const readHasEarlier = (transcript: Transcript): boolean => transcript.earlier !== null

/*
 * 待答的那一道：倒扫，走到人说的上一句话为止（pendingPermission）。
 *
 * 代价是这一轮的长度，不是整条对话的长度；而它交回的是转录里那个条目本身，
 * 所以在被答复之前恒是同一个引用 —— 订阅它的界面因此不会因为流式追加而醒。
 */
const readPending = (transcript: Transcript): PermissionItem | undefined =>
  pendingPermission(activeScope(transcript.timeline))

/* 同一趟扫描的另一格。交出的是数字，所以它比条目引用还稳。 */
const readPendingCount = (transcript: Transcript): number =>
  pendingPermissionCount(activeScope(transcript.timeline))

/* 待答的那一组题：与待答的审批同一趟倒扫、同一条引用稳定纪律（pendingQuestion）。 */
const readQuestion = (transcript: Transcript): QuestionTimelineItem | undefined =>
  pendingQuestion(activeScope(transcript.timeline))

export function useAssistantSession({
  endpoint,
  onUserMessage,
  prepare,
  session,
}: AssistantSessionOptions): AssistantSession {
  const transcripts = useTranscripts()

  const key = endpoint

  const running = useSlice(key, readStatus)
  const isRestoring = useSlice(key, readRestoring)
  const inflight = useSlice(key, readInflight)

  /* 忙不忙只有这一个产地：放行的拍子与出账簿的 isBusy 读的是同一个字。 */
  const busy = running !== 'ready' && running !== 'error'

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

  /* 送不出去就地记进转录，与本地事故同一处写法。 */
  const note = useCallback(
    (why: string) => {
      transcripts.note(key, why)
    },
    [key, transcripts],
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

  const answerQuestions = useCallback(
    (response: QuestionResponse) => {
      direct(note, () => session?.answerQuestions(response))
    },
    [note, session],
  )

  const dismissQuestions = useCallback(
    (questionId: string) => {
      direct(note, () => session?.dismissQuestions(questionId))
    },
    [note, session],
  )

  /*
   * 出账簿的三样外界能力走一格 ref。
   *
   * 它跨渲染活着（队列不能随重渲清空），而这三样每次渲染都换闭包 —— 直接交进
   * 构造函数就会钉住第一次的 endpoint。
   */
  const wired = useRef<{
    busy: boolean
    deliver: (said: Interjection) => void
    merge: (promptId: string) => void
  }>({ busy: false, deliver: () => undefined, merge: () => undefined })

  useEffect(() => {
    wired.current = {
      busy,
      deliver: (said) => {
        transcripts.send({
          assets: said.assets,
          configuration: said.configuration,
          onUserMessage,
          port: session,
          prepare,
          skills: said.skills,
          text: said.text,
          threadId: endpoint,
        })
      },
      merge: (promptId) => {
        if (session === undefined) {
          note(NO_SESSION)

          return
        }

        /* 并轮是一次对账：这一轮已经收口时 kap 必然回绝（40402），而那一句要的终局
           已经成立 —— kap 自己会把它跑掉。只有轮次还在跑时的失败才是失败。 */
        void session.steer(endpoint, [promptId]).catch((cause: unknown) => {
          if (wired.current.busy) {
            note(describeFailure(cause))
          }
        })
      },
    }
  }, [busy, endpoint, note, onUserMessage, prepare, session, transcripts])

  const [outbox] = useState(
    () =>
      new InterjectionOutbox({
        deliver: (said) => {
          wired.current.deliver(said)
        },
        isBusy: () => wired.current.busy,
        merge: (promptId) => {
          wired.current.merge(promptId)
        },
      }),
  )

  /* 这一轮收口了才放行：中途放一条出去，会把 agent 正在写的那一段从中间劈开。 */
  useEffect(() => {
    if (!busy) {
      outbox.idle()
    }
  }, [busy, outbox])

  /* 插队那一条要并进这一轮，kap 收下它之后才有号可并。 */
  useEffect(() => {
    if (inflight !== undefined) {
      outbox.claimed(inflight)
    }
  }, [inflight, outbox])

  const queued = useSyncExternalStore(outbox.subscribe, outbox.read).queue.length

  /* 排着话就是 queued：那一轮确实在跑，这一格说的是「后面还有」。 */
  const status: ChatStatus = queued > 0 ? 'queued' : running

  /* 说一句话，就是说一句话：排不排队由出账簿判，这一层不判。 */
  const send = useCallback(
    (submission: AssistantSubmission) => {
      outbox.say(submission)
    },
    [outbox],
  )

  return {
    key,
    status,
    send,
    cancel,
    resolvePermission,
    answerQuestions,
    dismissQuestions,
    outbox,
    isRestoring,
  }
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

/** 这条对话上面还有没有更早的一页。 */
export function useAssistantHasEarlier(key: string): boolean {
  return useSlice(key, readHasEarlier)
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
  pendingPermissionCall(activeScope(transcript.timeline))

/** 待答请求指向的那次调用；审批带照着它印字。 */
export function useAssistantPendingCall(key: string): ToolCallTimelineItem | undefined {
  return useSlice(key, readPendingCall)
}

/* 目标与蜂群各交一个原始值：字符串与数字，所以流式追加叫不醒那排胶囊。 */
/** 此刻还在跑的子代理数。 */
export function useAssistantSwarm(key: string): number {
  return useSlice(key, (t) => runningDelegations(t.timeline))
}

/*
 * 直走会话端口的那几个动作。
 *
 * 落账由帧完成（questions_resolved / prompt.steered / prompt.aborted 一到，条目自己
 * 就结清），所以它们不经 store。唯一要兜的是送不出去：就地记进转录。缺会话就是
 * 没有地方可送 —— 那也是一次要记的失败，不是静默。
 */
const direct = (note: (why: string) => void, ask: () => Promise<void> | void): void => {
  try {
    const sent = ask()

    if (sent === undefined) {
      note(NO_SESSION)

      return
    }

    void sent.catch((cause: unknown) => {
      note(describeFailure(cause))
    })
  } catch (cause) {
    note(describeFailure(cause))
  }
}
