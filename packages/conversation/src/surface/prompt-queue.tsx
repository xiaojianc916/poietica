import './prompt-queue.css'

import { memo, useCallback, useSyncExternalStore } from 'react'
import type { MessageQueue, MessageQueueState } from '../interjection/message-queue'
import { CloseIcon } from './primitives/icons'

export interface PromptQueueProps {
  /** 队列的真相：agent 报来的快照。这一层只画它、只按它给的顺序画。 */
  readonly queue: MessageQueue
  /** 把撤回的那一句取回输入框改。 */
  readonly onEdit: (text: string) => void
}

interface RowProps {
  readonly text: string
  readonly last: boolean
  readonly onWithdraw: () => void
}

/*
 * 一行。
 *
 * 只有最后一行能撤：上游的撤回是 LIFO（`popLastQueuedMessage`），没有按号取这一说。
 * 把不能撤的那几行也画上按钮，等于给一个按不动的键。
 */
const QueueRow = memo(function QueueRow({ text, last, onWithdraw }: RowProps) {
  return (
    <li className="prompt-queue__row">
      <span className="prompt-queue__said" title={text}>
        {text}
      </span>

      {last ? (
        <button
          aria-label="撤回这一句"
          className="prompt-queue__act"
          onClick={onWithdraw}
          title="撤回这一句，正文回输入框（只能从最后一句起按顺序撤）"
          type="button"
        >
          <CloseIcon aria-hidden size={14} />
          撤回
        </button>
      ) : null}
    </li>
  )
})

/*
 * 输入框上方那条队列。
 *
 * omp 的 steering / followUp 两个队列住在 agent 里（`getQueuedMessages`），这里画的是
 * 它报来的那一份 —— 不重排、不预演：顺序是 agent 的出队顺序，改它只能靠撤回再重发。
 * 两层分两栏画，因为它们的语义不同：steering 是「下一批工具跑完就看见」，
 * followUp 是「这一轮跑完接着做」。
 */
/*
 * 三个队列模式。改一次就落 agent 自己的 config.yml（`setSteeringMode(mode)` 那三个
 * 官方写入面的 persist 默认为真），所以退出重开仍在。
 *
 * 只在有东西排队时画：没有待发的话，这三档改的是什么就无从对照 —— 摆一排正闲着的行为
 * 开关，人只会以为它们管的是别的事。
 */
const MODES = [
  {
    id: 'steeringMode',
    label: '插话',
    hint: '一次喂给模型几条：一条一条喂，它好接住正在做的事',
    choices: [
      { value: 'one-at-a-time', label: '一条一条' },
      { value: 'all', label: '一次全喂' },
    ],
  },
  {
    id: 'followUpMode',
    label: '排队',
    hint: '轮终之后接着做几条',
    choices: [
      { value: 'one-at-a-time', label: '一条一条' },
      { value: 'all', label: '一次全做' },
    ],
  },
  {
    id: 'interruptMode',
    label: '打断',
    hint: '插话要不要截断正在等的工具，还是等它做完这一批',
    choices: [
      { value: 'immediate', label: '立刻打断' },
      { value: 'wait', label: '等这批' },
    ],
  },
] as const

function ModeRow({
  queue,
  state,
}: {
  readonly queue: MessageQueue
  readonly state: MessageQueueState
}) {
  return (
    <li className="prompt-queue__modes">
      {MODES.map((mode) => {
        const current = state[mode.id]
        return (
          <span className="prompt-queue__mode" key={mode.id} title={mode.hint}>
            <span className="prompt-queue__mode-label">{mode.label}</span>
            {mode.choices.map((choice) => (
              <button
                aria-pressed={current === choice.value}
                className="prompt-queue__act"
                key={choice.value}
                onClick={() => {
                  void queue.configure({ [mode.id]: choice.value })
                }}
                type="button"
              >
                {choice.label}
              </button>
            ))}
          </span>
        )
      })}
    </li>
  )
}

export const PromptQueue = memo(function PromptQueue({ onEdit, queue }: PromptQueueProps) {
  const state: MessageQueueState = useSyncExternalStore(queue.subscribe, queue.read)
  const rows = [
    ...state.steering.map((text) => ({ text, tier: '插话' as const })),
    ...state.followUp.map((text) => ({ text, tier: '排队' as const })),
  ]

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

  return (
    <ul aria-label="排队等发的话" className="prompt-queue">
      {rows.map((row, index) => (
        <QueueRow
          key={`${row.tier}:${String(index)}`}
          last={index === rows.length - 1}
          onWithdraw={withdraw}
          text={`${row.tier} · ${row.text}`}
        />
      ))}

      <ModeRow queue={queue} state={state} />
    </ul>
  )
})
