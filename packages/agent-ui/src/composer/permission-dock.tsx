import './permission-dock.css'

import type { PermissionItem, ToolCallTimelineItem } from '@poietica/agent'
import type { PermissionOption } from '@poietica/agent-contract'
import { memo, useState } from 'react'
import { useAgentDialect } from '../semantics/agent-dialect'
import { clampToLine, readToolIntent } from '../semantics/tool-intent'

/**
 * 要批准的那一件事，就在下一句话的正上方。
 *
 * 它不是转录的一行：一次审批是拦在「继续」前面的一道闸，闸属于操作区，放进流里
 * 它会跟着滚动条走开，人得先找回它才能放行。它也不是浮在输入框上的第二块东西 ——
 * 它咬在那张卡（assistant.css 的 [data-slot="prompt-input"]）的上沿：自己画上半
 * 张脸，下沿多出一个圆角的量、被卡整个盖住。
 *
 * 接缝因此不存在，而不是被对齐：重叠的那一段盖多盖少都不露缝，所以两边没有任何
 * 一个数需要同步。此前两版各自失败在这一点上 —— 兄弟版靠三处约定假装贴着（自己
 * 画三条边、把下边置零、把上圆角抄一遍），孩子版把卡顶的圆角一起接管了，输入框
 * 那张卡就此不再完整。
 *
 * 同一条结论也已经写过一次：题组来的时候输入框自己长成面板（见 assistant-composer
 * 那段「后者会在滚动、聚焦和 Esc 上处处露馅」），而不是浮一个面板上去。审批与提问
 * 借的是同一条协议通道，没有理由用两种范式。
 *
 * 一次只画一个。并行的请求彼此独立，一个个答与一叠一起答在协议上没有分别，
 * 而一个个答不需要把这条带子改成队列 —— 序号只报分母（见 pendingPermissionCount）。
 *
 * 答完什么都不留。剩下的是一次操作痕迹，而痕迹归事件日志：原生侧的
 * permission_requested / permission_resolved 一条不少，转录不做第二个事实来源。
 * 见 docs/adr/0003。
 */

/*
 * 按钮上的字是显示，不是身份。回给 agent 的永远是 optionId。
 *
 * 认 name，不认 kind：kind 会重复（kimi 的 approve_once 与 approve_always 同为
 * allow_once），按 kind 查表的结果是两颗按钮写着同一个词。name 是协议里的
 * human-readable label。查不到就照原文显示 —— 宁可显示英文，也不能显示一个
 * 错的中文。
 */
function labelFor(option: PermissionOption, labels: Readonly<Record<string, string>>): string {
  return labels[option.name] ?? option.name
}

/*
 * 被涂色的只有一颗。
 *
 * 此前是「所有 allow_once 都涂」，而 kimi 一次送来两颗 allow_once（批准一次、
 * 本会话都批准）—— 两颗一样重，人看不出默认动作是哪一个。agent 把它想要的那个
 * 排在前面，所以第一颗放行选项就是主按钮。
 */
function leadOf(options: readonly PermissionOption[]): string | undefined {
  return options.find((option) => option.kind.startsWith('allow'))?.optionId
}

/**
 * 说不出意图时，把入参原样端上来。
 *
 * tool-intent 那一层的取舍是「宁可少说一句，不肯说错一句」，那对一张事后翻看的卡片
 * 是对的。这里相反：人正要为这一次调用签字，而一个只写着工具名的问题不能被回答。
 * 原文不是猜测 —— 它就是要被批准的那份入参。
 *
 * 它住在带子里而不是 tool-intent 里，正因为这条取舍只属于审批这一个场景。
 */
function rawArgs(rawInput: unknown): string | null {
  if (rawInput === undefined || rawInput === null) {
    return null
  }

  try {
    const text = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)

    return text === undefined ? null : clampToLine(text)
  } catch {
    /* 认不出就不认，宁可只剩一个工具名，也不能印一句我们编的话。 */
    return null
  }
}

export interface PermissionDockProps {
  readonly item: PermissionItem
  /** 请求指向的那次调用；带子印的字来自它。 */
  readonly call: ToolCallTimelineItem | undefined
  /** 本段里还在等的一共几个。1 表示只有这一个，序号因此不出现。 */
  readonly waiting: number
  readonly onResolve: (requestId: string, optionId: string) => void
}

export const PermissionDock = memo(function PermissionDock({
  call,
  item,
  onResolve,
  waiting,
}: PermissionDockProps) {
  const dialect = useAgentDialect()

  const [submitted, setSubmitted] = useState<string | undefined>(undefined)

  /*
   * 换了一个请求，就该从「一个都没点」重新开始。
   *
   * 渲染期直接改自己的 state 是 React 官方给「props 变了要复位 state」的写法，
   * 本次渲染内重跑，不多一帧，也不需要 effect。不用 key：key 会把整条带子重新
   * 挂载，于是下一个请求顶上来时撑开动画会再播一遍 —— 连着三个审批闪三下。
   */
  const [asked, setAsked] = useState(item.requestId)

  if (asked !== item.requestId) {
    setAsked(item.requestId)
    setSubmitted(undefined)
  }

  /*
   * 不包 useCallback。
   *
   * 它唯一的读者是下面那个内联箭头（onClick={() => handleSelect(...)}），而那个
   * 箭头每次渲染都是新的 —— 稳定这一层的身份因此没有任何人在读，换来的只是每次
   * 渲染多一次依赖数组的分配与比较。要么两处都稳，要么两处都不稳；三四颗按钮
   * 不值得为它引一层 per-option 的回调缓存。
   */
  const handleSelect = (optionId: string) => {
    setSubmitted(optionId)
    onResolve(item.requestId, optionId)
  }

  /*
   * 要批准的那件事本身。
   *
   * 工具名回答不了「要不要允许 Bash」。判据与工具卡片同一个函数，两处不会各说
   * 一套；意图说不出来退到入参原文，再退才是工具名 —— 那时 agent 确实没说。
   */
  const intent = call === undefined ? null : readToolIntent(call)

  const said = intent?.text ?? rawArgs(call?.rawInput) ?? item.title

  const lead = leadOf(item.options)

  const isSubmitting = submitted !== undefined

  return (
    <div className="assistant-approval">
      {/* key 在里层：换请求时只有内容交叉淡入，外壳不重放撑开。 */}
      <div aria-busy={isSubmitting} className="assistant-approval__bar" key={item.requestId}>
        {waiting > 1 ? <span className="assistant-approval__count">1/{waiting}</span> : null}

        {/* 原样：不加前缀、不翻译、不改写。 */}
        <span className="assistant-approval__intent">{said}</span>

        <div className="assistant-approval__options">
          {item.options.map((option) => (
            <button
              className="assistant-approval__option"
              data-lead={option.optionId === lead ? 'true' : undefined}
              data-pending={option.optionId === submitted ? 'true' : undefined}
              disabled={isSubmitting}
              key={option.optionId}
              onClick={() => {
                handleSelect(option.optionId)
              }}
              type="button"
            >
              {labelFor(option, dialect.optionLabels)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
})
