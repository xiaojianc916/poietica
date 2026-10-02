import './prompt-queue.css'

import { Tooltip, TooltipContent, TooltipTrigger } from '@poietica/design-system'
import {
  memo,
  type ReactNode,
  type SVGProps,
  useCallback,
  useState,
  useSyncExternalStore,
} from 'react'
import type { MessageQueue, MessageQueueState } from '../interjection/message-queue'
import {
  AllAtOnceIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  FollowUpIcon,
  HaltIcon,
  InterruptIcon,
  OneAtATimeIcon,
  SteerIcon,
  WaitIcon,
} from './primitives/icons'

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
 * 必须一眼看得出。`tier` 不进屏幕的字面 —— 两个队的名字走提示条（见下面那一行），免得
 * 每行前面先出现一个词才开始正文。
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
 * 三个队列模式。改一次就落 agent 自己的 config.yml（`setSteeringMode(mode)` 那三个官方
 * 写入面的 persist 默认为真），所以退出重开仍在。
 *
 * 只在有东西排队时画：没有待发的话，这三档改的是什么就无从对照 —— 摆一排正闲着的行为
 * 开关，人只会以为它们管的是别的事。
 *
 * 每组的名字（插话 / 排队 / 打断）不进屏幕：它做那一组记号钮的提示条。前两组的字形是
 * 同一对，所以各自还要一枚记号钮把「这一组管的是哪个队」说出来 —— 那枚记号自己也是一条
 * 提示，指着它才知道这一组是什么。
 */
const MODES = [
  {
    id: 'steeringMode',
    label: '插话',
    hint: '插进正在跑的那一轮：一次喂给模型几条',
    Mark: SteerIcon,
    choices: [
      { value: 'one-at-a-time', label: '插话一条一条喂', Icon: OneAtATimeIcon },
      { value: 'all', label: '插话一次全喂', Icon: AllAtOnceIcon },
    ],
  },
  {
    id: 'followUpMode',
    label: '排队',
    hint: '这一轮跑完接着做：一次做几条',
    Mark: FollowUpIcon,
    choices: [
      { value: 'one-at-a-time', label: '排队一条一条做', Icon: OneAtATimeIcon },
      { value: 'all', label: '排队一次全做', Icon: AllAtOnceIcon },
    ],
  },
  {
    id: 'interruptMode',
    label: '打断',
    hint: '插话要不要截断正在等的工具',
    Mark: HaltIcon,
    choices: [
      { value: 'immediate', label: '插话立刻打断工具', Icon: InterruptIcon },
      { value: 'wait', label: '插话等这批工具做完', Icon: WaitIcon },
    ],
  },
] as const

/*
 * 一枚按钮：28 的圆，一枚字形，话在提示条里。
 *
 * 正本每一枚操作钮都是这样（`IconEditOutlineRegular` / `IconTrashOutlineRegular` /
 * `IconSendOutlineRegular` 各配一条 Tooltip 与一条 aria-label），本仓照办：屏幕上不出现
 * 按钮的名字，名字只在屏幕阅读器与悬停提示里。
 *
 * `active` 只有那三组档位用：它们在「此刻是哪一档」上必须自证，所以按下的那一枚着色。
 */
function QueueAction({
  active,
  children,
  disabled,
  label,
  onClick,
}: {
  readonly active?: boolean
  readonly children: ReactNode
  readonly disabled?: boolean
  readonly label: string
  readonly onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={label}
            aria-pressed={active}
            className="prompt-queue__action"
            disabled={disabled === true}
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

/**
 * 输入框上方那条待发队列。
 *
 * 画法是 DeepSeek Harness 的 QueueDock（逐条对应见 prompt-queue.css 的头注），两处与它
 * 不同、都在画法上留了痕：
 *
 *   1. 本机的撤回是 LIFO 一条 `withdraw` 命令（正本按号 remove），所以只有最后一行画得出
 *      撤回键 —— 不给按不动的行画一枚假键。
 *   2. 一行前面那枚记号：只有一行时是队列记号（正本如此），两行以上换成**序号** —— 那时
 *      才真的有「谁先走」要交代。两个队的名字在记号自己的提示条里。
 *
 * 顺序是 agent 的出队顺序，这一层不重排、不预演；改一句只能撤回来重发。
 */
export const PromptQueue = memo(function PromptQueue({ onEdit, queue }: PromptQueueProps) {
  /* 三个实参：第三格是服务端快照。本仓的规矩与 session-controls-context 同形，测试里渲染
     静态标记时读的就是它 —— 缺了它，整棵子树在 markup 里是空的。 */
  const state: MessageQueueState = useSyncExternalStore(queue.subscribe, queue.read, queue.read)
  /*
   * 摊开是缺省态。
   *
   * 正本缺省折起（它的卡片上方还压着别的东西），本仓按产品口径翻过来：队列是在等发的话，
   * 序号就是「谁先走」，折起来这两样都看不见；头仍然点得动，只是不替人先收一道。
   */
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
                        <span
                          className={many ? 'prompt-queue__ordinal' : 'prompt-queue__lead'}
                          data-many={many ? '' : undefined}
                        >
                          {many ? row.ordinal : <QueueGlyph />}
                        </span>
                      }
                    />
                    <TooltipContent side="bottom">
                      {many ? `${row.tier} · 第 ${row.ordinal} 条` : row.tier}
                    </TooltipContent>
                  </Tooltip>

                  <span className="prompt-queue__said" title={row.text}>
                    {row.text}
                  </span>

                  <div className="prompt-queue__actions">
                    {row.last ? (
                      <QueueAction label="撤回这一句，正文回输入框" onClick={withdraw}>
                        <CloseIcon aria-hidden size={14} />
                      </QueueAction>
                    ) : null}
                  </div>
                </li>
              ))
            : null}
        </ul>

        <div className="prompt-queue__modes">
          {MODES.map((mode) => {
            const current = state[mode.id]
            return (
              <span className="prompt-queue__mode" key={mode.id}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span aria-hidden className="prompt-queue__mode-mark">
                        <mode.Mark size={14} />
                      </span>
                    }
                  />
                  <TooltipContent side="bottom">{mode.hint}</TooltipContent>
                </Tooltip>
                {mode.choices.map((choice) => (
                  <QueueAction
                    active={current === choice.value}
                    key={choice.value}
                    label={choice.label}
                    onClick={() => {
                      void queue.configure({ [mode.id]: choice.value })
                    }}
                  >
                    <choice.Icon aria-hidden size={14} />
                  </QueueAction>
                ))}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
})
