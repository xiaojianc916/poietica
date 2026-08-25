import './prompt-queue.css'

import type { Interjection, InterjectionOutbox } from '@poietica/agent'
import { memo, useCallback, useState, useSyncExternalStore } from 'react'
import { CloseIcon } from '../primitives/icons'

export interface PromptQueueProps {
  /** 队列的真相。这一层只画它、只按它给的顺序画。 */
  readonly outbox: InterjectionOutbox
  /** 把这一句取回输入框改。草稿仍归输入框，这里只交出正文。 */
  readonly onEdit: (text: string) => void
}

interface QueueRowProps {
  readonly index: number
  readonly item: Interjection
  readonly lifted: boolean
  readonly over: boolean
  readonly onArm: (index: number | null) => void
  readonly onEdit: (id: string) => void
  readonly onLand: (index: number) => void
  readonly onLift: (index: number) => void
  readonly onNudge: (id: string, by: number) => void
  readonly onOver: (index: number | null) => void
  readonly onRemove: (id: string) => void
  readonly onUrge: (id: string) => void
  readonly armed: boolean
}

const rowClass = (editing: boolean, lifted: boolean, over: boolean): string =>
  [
    'prompt-queue__row',
    editing ? 'prompt-queue__row--editing' : '',
    lifted ? 'prompt-queue__row--lifted' : '',
    over ? 'prompt-queue__row--over' : '',
  ]
    .filter((name) => name !== '')
    .join(' ')

/*
 * 一行。
 *
 * 拖拽走 HTML5 Drag and Drop：dataTransfer 必须被写过一次，否则 Firefox 不认这次
 * 拖动。把手只在悬浮时显形，按下它才把这一行变成可拖的 —— 否则整行都能被拖走，
 * 选文字都做不到。键盘用 Alt 加上下方向键走同一条 reorder。
 */
const QueueRow = memo(function QueueRow({
  armed,
  index,
  item,
  lifted,
  onArm,
  onEdit,
  onLand,
  onLift,
  onNudge,
  onOver,
  onRemove,
  onUrge,
  over,
}: QueueRowProps) {
  const editing = item.state === 'editing'

  return (
    <li
      className={rowClass(editing, lifted, over)}
      draggable={armed}
      onDragEnd={() => {
        onArm(null)
        onOver(null)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        onOver(index)
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', item.id)
        onLift(index)
      }}
      onDrop={(event) => {
        event.preventDefault()
        onLand(index)
      }}
    >
      <button
        aria-label="按住拖动改顺序，或按 Alt 加上下方向键"
        className="prompt-queue__grip"
        onKeyDown={(event) => {
          if (!event.altKey) {
            return
          }

          if (event.key === 'ArrowUp') {
            event.preventDefault()
            onNudge(item.id, -1)
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            onNudge(item.id, 1)
          }
        }}
        onPointerDown={() => {
          onArm(index)
        }}
        onPointerUp={() => {
          onArm(null)
        }}
        type="button"
      >
        {'\u283F'}
      </button>

      <span aria-hidden className="prompt-queue__ordinal">
        {index + 1}
      </span>

      <button
        className="prompt-queue__said"
        onClick={() => {
          onEdit(item.id)
        }}
        title={editing ? '正文在输入框里，改完发送就回到这个位置' : item.text}
        type="button"
      >
        {editing ? '正在输入框里改…' : item.text}
      </button>

      <button
        className="prompt-queue__act prompt-queue__act--urge"
        disabled={editing}
        onClick={() => {
          onUrge(item.id)
        }}
        title="立刻发给 AI，不等它做完手上这件事"
        type="button"
      >
        {'\u21B3 提交'}
      </button>

      <button
        aria-label="不发这一句"
        className="prompt-queue__act"
        onClick={() => {
          onRemove(item.id)
        }}
        title="不发这一句"
        type="button"
      >
        <CloseIcon aria-hidden size={14} />
      </button>
    </li>
  )
})

/*
 * 输入框上方那条队列。
 *
 * 顺序、正文与编辑占位都在出账簿里，这一层只订它；拖到哪一行、按下了哪个把手
 * 是指针的临时状态，不进领域态。空队列时整层不渲染。
 */
export const PromptQueue = memo(function PromptQueue({ onEdit, outbox }: PromptQueueProps) {
  const state = useSyncExternalStore(outbox.subscribe, outbox.read)
  const [armed, setArmed] = useState<number | null>(null)
  const [lifted, setLifted] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  const lift = useCallback((index: number) => {
    setLifted(index)
  }, [])

  const land = useCallback(
    (index: number) => {
      const held = lifted === null ? undefined : state.queue[lifted]

      setLifted(null)
      setOver(null)
      setArmed(null)

      if (held !== undefined) {
        outbox.reorder(held.id, index)
      }
    },
    [lifted, outbox, state.queue],
  )

  const nudge = useCallback(
    (id: string, by: number) => {
      const from = state.queue.findIndex((held) => held.id === id)

      if (from >= 0) {
        outbox.reorder(id, from + by)
      }
    },
    [outbox, state.queue],
  )

  const edit = useCallback(
    (id: string) => {
      const said = outbox.checkout(id)

      if (said !== undefined) {
        onEdit(said.text)
      }
    },
    [onEdit, outbox],
  )

  const remove = useCallback(
    (id: string) => {
      outbox.drop(id)
    },
    [outbox],
  )

  const urge = useCallback(
    (id: string) => {
      outbox.urge(id)
    },
    [outbox],
  )

  if (state.queue.length === 0) {
    return null
  }

  return (
    <ul aria-label="排队等发的话" className="prompt-queue">
      {state.queue.map((item, index) => (
        <QueueRow
          armed={armed === index}
          index={index}
          item={item}
          key={item.id}
          lifted={lifted === index}
          onArm={setArmed}
          onEdit={edit}
          onLand={land}
          onLift={lift}
          onNudge={nudge}
          onOver={setOver}
          onRemove={remove}
          onUrge={urge}
          over={over === index && lifted !== index}
        />
      ))}
    </ul>
  )
})
