import './prompt-queue.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@poietica/design-system'
import {
  memo,
  type ReactNode,
  type SVGProps,
  useCallback,
  useState,
  useSyncExternalStore,
} from 'react'
import type { MessageQueue, MessageQueueState } from '../interjection/message-queue'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, TuningIcon } from './primitives/icons'

/*
 * 正本那条队列的记号（DSH 的 ChatLinesOutlineArtwork）：一个说话的气泡里两行字。
 * 图标库的 MessageSquare 只有气泡、没有那两行，是另一张图 —— 与 prompt-chip 里
 * FileDocIcon 同一处境，所以同一条办法：字形就近放在用它的这一处。
 */
function QueueGlyph({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      strokeWidth={1}
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M5 6.75H11" stroke="currentColor" />
      <path d="M5 9H8" stroke="currentColor" />
      <path
        d="M2.37067 11.2497C1.5872 9.89252 1.32042 8.29798 1.61945 6.7597C1.91847 5.22141 2.76317 3.84293 3.99801 2.87809C5.23285 1.91325 6.7747 1.427 8.33964 1.50888C9.90458 1.59076 11.3873 2.23526 12.5147 3.32369C13.6422 4.41232 14.3384 5.8717 14.4751 7.43304C14.6118 8.99438 14.1797 10.5525 13.2585 11.8205C12.3372 13.0885 10.9889 13.9809 9.4617 14.3334C8.18666 14.6277 6.8587 14.529 5.64964 14.0601C5.17095 13.8745 4.76937 13.4929 4.26509 13.3963C3.67389 13.2832 2.95232 13.5595 2.0377 14.3334"
        stroke="currentColor"
      />
    </svg>
  )
}

export interface PromptQueueProps {
  /** 队列的真相：agent 报来的快照。这一层只画它、只按它给的顺序画。 */
  readonly queue: MessageQueue
  /** 把撤回的那一句取回输入框改。 */
  readonly onEdit: (text: string) => void
}

/*
 * 一行待发的正文，加上它排在第几、排在哪一层。
 *
 * `ordinal` 是屏幕上那个序号：队列**有序**（撤回只从最后一条起），连排几句时哪句先走
 * 必须一眼看得出。`tier` 不进屏幕的字面 —— 两个队的名字走提示条，免得每行前面先出现
 * 一个词才开始正文。
 */
export interface QueueRow {
  readonly text: string
  readonly tier: string
  readonly ordinal: number
  readonly last: boolean
}

/** 队列快照摊成几行。纯函数：顺序、序号与署名都在这里定，画的那一层不再判一次。 */
export function queueRows(state: MessageQueueState): readonly QueueRow[] {
  const rows = [
    ...state.steering.map((text) => ({ text, tier: '插话' })),
    ...state.followUp.map((text) => ({ text, tier: '排队' })),
  ]

  return rows.map((row, index) => ({
    ...row,
    ordinal: index + 1,
    last: index === rows.length - 1,
  }))
}

/*
 * 三个队列模式。
 *
 * 它们不占屏幕：整条队列只画一行正文一行（见下面的组件）。正本每一行右侧那几枚按钮是
 * 「编辑 / 删除 / 插话发送」三件对**这一行正文**的操作，而这三个模式是**整条队列**的
 * 设置 —— 摆进行的按钮列里，人读到的是「这一句能一次全喂」，那是错的。
 *
 * 面板里每一档都带名字：面板是点开才出现的，一行一个词不会读成行的一部分。
 */
const MODES = [
  {
    id: 'steeringMode',
    label: '插话：一次喂几条',
    choices: [
      { value: 'one-at-a-time', label: '一条一条喂' },
      { value: 'all', label: '一次全喂' },
    ],
  },
  {
    id: 'followUpMode',
    label: '排队：轮终后做几条',
    choices: [
      { value: 'one-at-a-time', label: '一条一条做' },
      { value: 'all', label: '一次全做' },
    ],
  },
  {
    id: 'interruptMode',
    label: '插话要不要打断工具',
    choices: [
      { value: 'immediate', label: '立刻打断' },
      { value: 'wait', label: '等这批做完' },
    ],
  },
] as const

/*
 * 一行右侧那枚按钮。它跟着行，不另起一列 —— 行的布局是「正文 flex:auto + 按钮 flex:none」，
 * 所以按钮永远贴在这一行的右缘。
 *
 * 名字只在屏幕阅读器与悬停提示里：正本每一枚操作钮都是这么给的（一枚字形配一条 Tooltip
 * 与一条 aria-label）。
 */
function RowAction({
  children,
  label,
  onClick,
}: {
  readonly children: ReactNode
  readonly label: string
  readonly onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={label}
            className="prompt-queue__action"
            onClick={onClick}
            type="button"
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/*
 * 队列设置：末尾那条上的一枚「调整」。
 *
 * 三个模式都在这里，一条一行（正本的行是 34 高、13/20 的字、圆角 12 —— 设计系统的
 * Menu 原样给）。写的是 `delivery` 命令，它同时改运行时与落 agent 自己的 config.yml。
 */
function QueueTuning({
  queue,
  state,
}: {
  readonly queue: MessageQueue
  readonly state: MessageQueueState
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button aria-label="队列设置" className="prompt-queue__action" type="button">
            <TuningIcon aria-hidden size={14} />
          </button>
        }
      />
      {/* 弹层经 Portal 落 body，[data-assistant-skin] 罩不到，所以在这一层重新挂上。 */}
      <DropdownMenuContent
        align="end"
        className="assistant-menu-surface"
        data-assistant-skin
        side="top"
        sideOffset={6}
      >
        {MODES.map((mode, index) => (
          <div key={mode.id}>
            {index === 0 ? null : <DropdownMenuSeparator />}
            <DropdownMenuRadioGroup
              onValueChange={(value: string) => {
                void queue.configure({ [mode.id]: value })
              }}
              value={state[mode.id]}
            >
              <div className="prompt-queue__tuning-label">{mode.label}</div>
              {mode.choices.map((choice) => (
                <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                  <DropdownMenuRadioItemIndicator className="prompt-queue__tuning-tick">
                    <span className="prompt-queue__tuning-dot" />
                  </DropdownMenuRadioItemIndicator>
                  {choice.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * 输入框上方那条待发队列。
 *
 * 画法是 DeepSeek Harness 的 QueueDock（逐条对照见 prompt-queue.css 的头注）。正本一条
 * 队列只画一行（那是它的一层队列），本机三层所以要画三行；但**结构同形** —— 每一行是
 * 「记号 + 正文 + 右缘的操作钮」，不另起一列，也没有横排的设置条。
 *
 * 两处按本机机制不同、都在画法上留了痕：
 *
 *   1. 本机的撤回是 LIFO 一条 `withdraw` 命令（正本按号 remove、另有编辑与单条插话发送），
 *      所以**只有最后一行**画得出撤回键 —— 不给按不动的行画一枚假键。
 *   2. 三个队列模式是整条队列的设置（正本没有这个概念），收在末尾那枚「队列设置」里；
 *      摆成行的按钮列会被读成「这一句能一次全喂」。
 *
 * 顺序是 agent 的出队顺序，这一层不重排、不预演；改一句只能撤回来重发。
 */
export const PromptQueue = memo(function PromptQueue({ onEdit, queue }: PromptQueueProps) {
  /* 三个实参：第三格是服务端快照。本仓的规矩与 session-controls-context 同形，测试里渲染
     静态标记时读的就是它 —— 缺了它，整棵子树在 markup 里是空的。 */
  const state: MessageQueueState = useSyncExternalStore(queue.subscribe, queue.read, queue.read)
  /* 摊开是缺省态：队列是在等发的话，折起来连序号都看不见；头仍然点得动。 */
  const [collapsed, setCollapsed] = useState(false)
  const rows = queueRows(state)

  const withdraw = useCallback(() => {
    void queue.withdraw().then((restored) => {
      if (restored !== null) {
        onEdit(restored.text)
      }
    })
  }, [onEdit, queue])

  if (rows.length === 0) {
    return null
  }

  /*
   * 折叠头两行以上才画（正本同一条判据）：为一行再点一次头是白收一次 —— 那一行本来就
   * 摊着。列表长度是 agent 的出队顺序，它跑起来会自己变短，这一层不替它数。
   */
  const expanded = !collapsed
  const listVisible = rows.length === 1 || expanded
  const many = rows.length > 1

  return (
    <div className="prompt-queue" data-queue-dock>
      <div className="prompt-queue__panel">
        {many ? (
          <button
            aria-controls="prompt-queue-list"
            aria-expanded={expanded}
            className="prompt-queue__header"
            onClick={() => {
              setCollapsed((value) => !value)
            }}
            type="button"
          >
            <span aria-hidden className="prompt-queue__lead">
              <QueueGlyph />
            </span>
            <span className="prompt-queue__count">{rows.length} 条排队消息</span>
            <span aria-hidden className="prompt-queue__chevron">
              {expanded ? <ChevronDownIcon size={14} /> : <ChevronUpIcon size={14} />}
            </span>
          </button>
        ) : null}

        <ul className="prompt-queue__list" hidden={!listVisible} id="prompt-queue-list">
          {listVisible
            ? rows.map((row) => (
                <li className="prompt-queue__row" key={`${row.tier}:${String(row.ordinal)}`}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className={many ? 'prompt-queue__ordinal' : 'prompt-queue__lead'}>
                          {many ? row.ordinal : <QueueGlyph />}
                        </span>
                      }
                    />
                    <TooltipContent side="bottom">
                      {many ? `${row.tier} · 第 ${String(row.ordinal)} 条` : row.tier}
                    </TooltipContent>
                  </Tooltip>

                  <span className="prompt-queue__said" title={row.text}>
                    {row.text}
                  </span>

                  {/*
                   * 右缘那几枚，就在这一行的 flex 里。
                   *
                   * 撤回只在最后一行（LIFO）；队列设置跟着最后一行一起 —— 它是整条队列唯一
                   * 的设置入口，单独占一行就是「按钮自己一列」，而正本每一枚钮都贴在行右缘。
                   */}
                  {row.last ? (
                    <>
                      <QueueTuning queue={queue} state={state} />
                      <RowAction label="撤回这一句，正文回输入框" onClick={withdraw}>
                        <CloseIcon aria-hidden size={14} />
                      </RowAction>
                    </>
                  ) : null}
                </li>
              ))
            : null}
        </ul>
      </div>
    </div>
  )
})
