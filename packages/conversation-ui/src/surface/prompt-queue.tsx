import './prompt-queue.css'

import type { Interjection, InterjectionOutbox } from '@poietica/conversation'
import { Reorder, useDragControls } from 'motion/react'
import { memo, useCallback, useSyncExternalStore } from 'react'
import { CloseIcon, DragHandleIcon, ForwardIcon, PencilIcon } from '../primitives/icons'
import { DRAG_SPRING } from '../primitives/motion'

/** 面板到顶的行数，与 --cp-queue-rows 同源：超过它就有东西在视野外。 */
const VISIBLE_ROWS = 5

export interface PromptQueueProps {
  /** 队列的真相。这一层只画它、只按它给的顺序画。 */
  readonly outbox: InterjectionOutbox
  /** 把这一句取回输入框改。草稿仍归输入框，这里只交出正文。 */
  readonly onEdit: (text: string) => void
}

interface RowProps {
  readonly item: Interjection
  readonly onEdit: (id: string) => void
  readonly onNudge: (id: string, by: number) => void
  readonly onRemove: (id: string) => void
  readonly onUrge: (id: string) => void
}

/*
 * 一行。
 *
 * 拖拽走 Reorder.Item：指针事件，触控与笔一并支持，落位由 layout 补间。
 * dragListener 关掉，起手权归把手；键盘走 Alt 加上下方向键。
 *
 * 拖动期间不缩放：这一行里最小的东西是 14px 的字形，一次非整数缩放把它的起点推到
 * 半个设备像素上（composer-metrics.css 的居中偏移那一条）。浮起由把手 :active 的
 * 投影表达，那一层不动几何。
 */
const QueueRow = memo(function QueueRow({ item, onEdit, onNudge, onRemove, onUrge }: RowProps) {
  const drag = useDragControls()
  const editing = item.state === 'editing'

  return (
    <Reorder.Item
      className="prompt-queue__row"
      data-editing={editing ? 'true' : undefined}
      dragControls={drag}
      dragListener={false}
      transition={DRAG_SPRING}
      value={item}
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
        onPointerDown={(event) => {
          drag.start(event)
        }}
        type="button"
      >
        <DragHandleIcon aria-hidden size={14} />
      </button>

      <span
        className="prompt-queue__said"
        title={editing ? '正文在输入框里，改完发送就回到这个位置' : item.text}
      >
        {editing ? '正在输入框里改…' : item.text}
      </span>

      <button
        aria-label="改这一句"
        className="prompt-queue__act prompt-queue__act--glyph"
        disabled={editing}
        onClick={() => {
          onEdit(item.id)
        }}
        title="改这一句：正文回输入框，位置留着"
        type="button"
      >
        <PencilIcon aria-hidden size={14} />
      </button>

      <button
        className="prompt-queue__act"
        disabled={editing}
        onClick={() => {
          onUrge(item.id)
        }}
        title="立刻发给 AI，不等它做完手上这件事"
        type="button"
      >
        <ForwardIcon aria-hidden size={14} />
        提交
      </button>

      <button
        aria-label="不发这一句"
        className="prompt-queue__act prompt-queue__act--glyph"
        onClick={() => {
          onRemove(item.id)
        }}
        title="不发这一句"
        type="button"
      >
        <CloseIcon aria-hidden size={14} />
      </button>
    </Reorder.Item>
  )
})

/*
 * 输入框上方那条队列。
 *
 * 顺序、正文与编辑占位都在出账簿里：这一层只订它，并把新顺序整条交回 —— 交 id 不交
 * 下标，所以拖动期间队首被放行也不会挪错人。最上面就是最先发送的那一句。
 *
 * 到顶了由行数说，不靠量高度：行高由令牌给，整行等高，所以「有没有东西在视野外」
 * 是一次比较，不是一次测量。
 */
export const PromptQueue = memo(function PromptQueue({ onEdit, outbox }: PromptQueueProps) {
  const state = useSyncExternalStore(outbox.subscribe, outbox.read)

  const arrange = useCallback(
    (order: Interjection[]) => {
      outbox.arrange(order.map((held) => held.id))
    },
    [outbox],
  )

  /* 键盘挪一格：与拖拽同一个写入口。 */
  const nudge = useCallback(
    (id: string, by: number) => {
      const order = state.queue.map((held) => held.id)
      const from = order.indexOf(id)
      const to = from + by

      if (from < 0 || to < 0 || to >= order.length) {
        return
      }

      order.splice(from, 1)
      order.splice(to, 0, id)
      outbox.arrange(order)
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
    <Reorder.Group
      aria-label="排队等发的话"
      axis="y"
      className="prompt-queue"
      data-more={state.queue.length > VISIBLE_ROWS ? 'true' : undefined}
      onReorder={arrange}
      values={[...state.queue]}
    >
      {state.queue.map((item) => (
        <QueueRow
          item={item}
          key={item.id}
          onEdit={edit}
          onNudge={nudge}
          onRemove={remove}
          onUrge={urge}
        />
      ))}
    </Reorder.Group>
  )
})
