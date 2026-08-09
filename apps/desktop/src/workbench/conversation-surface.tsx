import type { AgentSessionPort } from '@poietica/agent-contract'
import {
  AssistantSurface,
  installAttachmentIntake,
  useAgentControls,
  type WorkspacePickerProps,
} from '@poietica/agent-ui'
import { createAttachmentIntake } from '@poietica/desktop-adapters'
import { useCallback, useEffect } from 'react'
import {
  useThreadSelectorFailure,
  useThreadSelectors,
  useThreadsActions,
} from '../assistant/threads-context'

/*
 * 一格只画一条对话。
 *
 * 标签的身份由工作台保管（conversation:<threadId>），所以这里没有自己的标签条。
 *
 * 名字是这里唯一额外接的一根线：兜底标题就是“我”说的第一句，那句话一发出，
 * 列表立刻改名并补上这一行（原生侧同一次 agent_prompt 也会把它写成 message
 * 来源的标题），随后刷新把官方标题接回来——官方标题永远压过临时的那个。
 *
 * 对话的 id 随那句话一起送来，不从这里的闭包里取：入口那一格在说话的那一刻
 * 才知道自己是哪条对话，闭包里的还是说话之前的答案，也就是没有答案。
 */

export interface ConversationSurfaceProps {
  /** 取得这一格即将成为的那条对话。只有入口那一格需要它。 */
  readonly onIdentify?: (() => Promise<string | null>) | undefined
  /** 这条对话说出第一句话时，带上它当时的名字。 */
  readonly onStarted?: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  readonly threadId: string | null
  /** 只有新对话入口会交出这项。 */
  readonly workspace?: Omit<WorkspacePickerProps, 'placement'> | undefined
}

/*
 * 输入框的收件口，一个进程一份。
 *
 * 装在模块求值时，不装在 effect 里：它不随任何一条对话变化，而且拖放监听要在
 * 第一次渲染之前就位。会话本身仍然是懒开的（见 createAttachmentIntake）。
 */
installAttachmentIntake(createAttachmentIntake())

export function ConversationSurface({
  onIdentify,
  onStarted,
  session,
  threadId,
  workspace,
}: ConversationSurfaceProps) {
  const threads = useThreadsActions()

  /*
   * 这一格只关心这两样，所以只订这两样。
   *
   * 两者在真的变化之前都是同一个引用，因此别的对话被打开、agent 报一次表、
   * 侧栏改个名，都不会走到这里。
   */
  const offered = useThreadSelectors(threadId)

  const failure = useThreadSelectorFailure(threadId)

  /*
   * 打开一条已有的对话，就为它开一个 ACP 会话。
   *
   * 入口那一格没有身份可以"预先准备"。它此前会在指针移入或聚焦时调用 onIdentify,
   * 也就是拿一次鼠标经过去认领一条真的对话：于是用户什么都还没说，这一格就已经有
   * 了 endpoint，useAssistantSession 在渲染期立刻 opening(endpoint) 并把 isRestoring
   * 置真，输入框跟着落到底部，随后又弹回原位。预取只许影响缓存，不许影响 UI 状态,
   * 而这里它影响的是这一格的身份。
   *
   * 而且它本来就是多余的：身份在发言的那一刻就会取到（useAssistantSession.send 里
   * appendUserMessage → identify() → prompt），提前认领一次，除了多出一条没人要的
   * 对话之外什么也没换来。
   *
   * 已有对话这一路不一样：adopt 只为一条已经存在的对话开会话、拿它的选择器和它
   * 的经过，不改这一格的身份，因此动不了排版；它是幂等的，重复触发安全。
   *
   * 它此前挂在 onEngage 上 —— 指针移入或聚焦输入框才装载，理由是"开会话贵"。
   * 那个理由在屏幕上的历史还来自本地日志的时候成立：历史另有来源，会话晚一点
   * 开无非是第一句话慢一点。历史改由持有它的 agent 交回来之后，这句权衡的意思
   * 就变成了"不把鼠标移到输入框上，这条对话就永远是一块白板"，而且连加载图标
   * 都不会出现 —— opening() 从没被调用过，isRestoring 一直是假。
   *
   * 打开就是装载。贵也得付，那是这条对话的内容本身。
   */
  useEffect(() => {
    if (threadId === null) {
      return
    }

    threads.adopt(threadId)
  }, [threadId, threads])

  /*
   * 两个 scope，一条判据。
   *
   * 入口那一格既没有对话也没有会话，它画的是这一家 agent 的表 —— 能力属于 agent,
   * 人想用哪个模型更是他自己的事，两者都不需要一条对话存在。进了对话之后画的是那条
   * 会话自己的表（见 @poietica/agent 的 SessionControlsStore）：ACP 的配置是会话级的,
   * 一条会话选了什么说明不了另一条选了什么。
   *
   * 所以读、写、重试三样都按同一个 threadId === null 分岔。少分一样就够了：写恒发往
   * 锚会话时，屏幕上显示的是这条会话的值，改动却落在另一条会话和 config.toml 上，而
   * session-controls-store.ts 开头把「屏幕写甲、会话跑乙」列为不允许存在的状态。
   *
   * 已有对话在自己的表到达之前先画 agent 那张：那是一份已知的真话，比一个空工具条
   * 再长出来好。
   */
  const { controls: known, failure: knownFailure, retry, selectControl } = useAgentControls()

  const controls = threadId === null ? known : (offered ?? known)

  const controlsFailure = threadId === null ? knownFailure : failure

  /*
   * 交下去的每一个回调都钉住标识。
   *
   * AssistantSurface 是 memo 过的，而内联箭头每次渲染都是新引用 —— 那样的 memo
   * 一次也命中不了：这一格但凡重画一次，转录、虚拟列表、输入框整棵树跟着走一遍。
   */
  const retryControls = useCallback(() => {
    if (threadId === null) {
      retry()

      return
    }

    threads.retrySelectors(threadId)
  }, [retry, threadId, threads])

  /* 改一项，交给持有这张表的那一方：入口那格是 agent，对话里是那条会话。 */
  const chooseControl = useCallback(
    (controlId: string, value: string) => {
      if (threadId === null) {
        selectControl(controlId, value)

        return
      }

      threads.selectControl(threadId, controlId, value)
    },
    [selectControl, threadId, threads],
  )

  const userMessage = useCallback(
    (conversation: string, text: string) => {
      threads.noteUserMessage(conversation, text)
      onStarted?.(conversation, threads.standInTitle(text))
    },
    [onStarted, threads],
  )

  return (
    <AssistantSurface
      controls={controls}
      controlsFailure={controlsFailure}
      endpoint={threadId}
      identify={onIdentify}
      onRetryControls={retryControls}
      onSelectControl={chooseControl}
      onUserMessage={userMessage}
      session={session}
      workspace={workspace}
    />
  )
}
