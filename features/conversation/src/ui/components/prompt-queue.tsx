import './prompt-queue.css'

import { Tooltip, TooltipContent, TooltipTrigger } from '@poietica/design-system'
import { memo, type ReactNode, type SVGProps, useCallback, useState, useSyncExternalStore } from 'react'
import type { PromptDelivery, QueuedDelivery } from '../agent/session'
import type { MessageQueue, MessageQueueState } from '../interjection/message-queue'
import { ChevronDownIcon, ChevronUpIcon, QueueSteerIcon, TrashIcon } from './primitives/icons'

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
 * 必须一眼看得出。`tier` 是这一行的投递层，走提示条不进行里的字面；`layer` 是同一个
 * 事实的机器那一面 —— 那枚换层图标靠它知道「现在这一条就在哪一层」。
 */
export interface QueueRow {
  /** 队列项在引擎账本里的号：撤回与换层都按它点名（R-01 §3.8）。 */
  readonly id: string
  readonly text: string
  readonly tier: string
  readonly layer: PromptDelivery
  readonly ordinal: number
  /** 这一行就是两枚控件（换层一枚 + 撤回一枚）改的那一条：撤回是 LIFO，只有它动得了。 */
  readonly last: boolean
}

/*
 * 队列快照摊成几行。纯函数：顺序、序号、层与署名都在这里定，画的那一层不再判一次。
 *
 * 两层接着数，走的是一个队：steering 先走（下一批工具跑完就看见），followUp 后走。
 */
export function queueRows(state: MessageQueueState): readonly QueueRow[] {
  const rows = [
    ...state.steering.map((item) => ({ id: item.id, text: item.text, tier: '插话', layer: 'steer' as const })),
    ...state.followUp.map((item) => ({ id: item.id, text: item.text, tier: '排队', layer: 'followUp' as const })),
  ]

  return rows.map((row, index) => ({
    ...row,
    ordinal: index + 1,
    last: index === rows.length - 1,
  }))
}

/*
 * 点一枚换层图标之后，那一条该去哪一档；null 就是「这一下什么都不用做」。
 *
 * 缺省是 `followUp`（这一轮跑完再送出去），所以**再点一次已经按下的那一枚就是收回**，
 * 退回缺省 —— 这正是缺省那一档不画图标的意思：屏幕上没有按下的图标就是它。
 */
export function nextLayer(current: PromptDelivery | undefined, clicked: QueuedDelivery): QueuedDelivery | null {
  if (current === undefined) {
    return null
  }
  const target = current === clicked ? 'followUp' : clicked
  return target === current ? null : target
}

/*
 * 屏幕上此刻该画的那几行。
 *
 * `moving` 是正在换层的那一条：换层是「撤回再重投」两步，两步之间 agent 报来的快照里
 * 那一条**真的不在**了。照快照画，面板就会整块卸载、过一会儿再整块长回来 —— 人读到的
 * 是「闪一下」。所以搬动期间把它接在队尾继续画，快照一还回来就让位（判据是正文，否则
 * 同一句话会画成两行）。
 *
 * 序号重算：它是屏幕上的「第几条」，而这一条此刻本来就不在快照里，接上就该接着数。
 */
export function queueView(rows: readonly QueueRow[], moving: QueueRow | undefined): readonly QueueRow[] {
  if (moving === undefined || rows.some((row) => row.text === moving.text)) {
    return rows
  }

  /* 快照里已经有可操作的那一条时不抢这一格：这一格永远只有一行。 */
  return [...rows, { ...moving, ordinal: rows.length + 1, last: !rows.some((row) => row.last) }]
}

/*
 * 投递档里**不是缺省**的那一档，一枚图标。
 *
 * 缺省是 `followUp`（这一轮跑完再送出去），它不画图标 —— 屏幕上没有图标就是它。
 * 给缺省态也画一枚键，人读到的是「要按一下才生效」。
 *
 * 上游还有一档 `aside`，本仓不接（见 ADR 0034）：上游既不报它排在哪，也不报它何时被
 * 吃掉，画出来的行会永远留在屏幕上。
 *
 * 名字只在屏幕阅读器与悬停提示里：正本每一枚操作钮都是这么给的。
 */
const DELIVERIES = [{ deliverAs: 'steer', label: '插话：插进正在跑的这一轮', Icon: QueueSteerIcon }] as const

/*
 * 一枚操作钮：28 的圆，一枚字形，话在提示条里。
 *
 * `active` 是「这一条现在就在这一层」：按下的那一枚着色并铺底，与设计系统的分段控件
 * 同一条口径。
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

/*
 * 换层的那枚图标。
 *
 * 它们改的是**最后那一条**（撤回再重投，见 onRedeliver），所以只有最后一行画得出。
 * 其余行画不了 —— 不给按不动的行画一枚假键。
 *
 * `current` 是那一条此刻在哪一层：按下的那一枚因此着色铺底。缺了它，点下去屏幕上
 * 什么都不动（正文与位置都没变），人读到的是「这键没反应」。
 */
function RowDeliveries({
  current,
  disabled,
  onPick,
}: {
  readonly current: PromptDelivery | undefined
  readonly disabled: boolean
  readonly onPick: (deliverAs: QueuedDelivery) => void
}) {
  return (
    <>
      {DELIVERIES.map((delivery) => (
        <QueueAction
          active={current === delivery.deliverAs}
          disabled={disabled}
          key={delivery.deliverAs}
          label={delivery.label}
          onClick={() => {
            onPick(delivery.deliverAs)
          }}
        >
          <delivery.Icon aria-hidden size={14} />
        </QueueAction>
      ))}
    </>
  )
}

/**
 * 输入框上方那条待发队列。
 *
 * 画法是 DeepSeek Harness 的 QueueDock（逐条对照见 prompt-queue.css 的头注）。正本一条
 * 队列只画一行，本机两层所以要画两行；但**结构同形** —— 每一行是「记号 + 正文 + 右缘的
 * 操作钮」，不另起一列，也没有横排的设置条。
 *
 * 四处按本机机制不同、都在画法上留了痕：
 *
 *   1. 撤回与换层都**按号点名**（`queue.withdraw` / `queue.move`），底层支持任意一行；
 *      但按钮的位置与样式不在本页范围（R-01 §3.8），所以仍然只画在最后一行。
 *   2. 一行时没有折叠头，两枚图标就贴那一行的右缘；多行时贴折叠头（「N 条排队消息」）的
 *      右缘 —— 它们改的是**最后那一条**。
 *
 * 顺序是 agent 的出队顺序，这一层不重排、不预演。
 */
export const PromptQueue = memo(function PromptQueue({ onEdit, queue }: PromptQueueProps) {
  /* 三个实参：第三格是服务端快照。本仓的规矩与 session-controls-context 同形，测试里渲染
     静态标记时读的就是它 —— 缺了它，整棵子树在 markup 里是空的。 */
  const state: MessageQueueState = useSyncExternalStore(queue.subscribe, queue.read, queue.read)
  /* 摊开是缺省态：队列是在等发的话，折起来连序号都看不见；头仍然点得动。 */
  const [collapsed, setCollapsed] = useState(false)

  /*
   * 正在换层的那一条（非空即「搬动中」）。
   *
   * 它不是队列的第二份，是这一次操作的落点：搬动期间照它画，操作一落就交还给快照
   * （见 `queueView`）。
   */
  const [moving, setMoving] = useState<QueueRow | undefined>(undefined)
  const pending = moving !== undefined

  const rows = queueRows(state)
  const visible = queueView(rows, moving)

  /* 两枚控件改的都是**最后那一条**（按钮位置的产品选择），它的层就是「当前那一层」。 */
  const last = visible.find((row) => row.last)

  /*
   * 换层：服务端的 `queue.move` 按号把这一条换到另一层，用账本里的原始输入重新入队
   * （图片 / 文件 / 技能都保留，R-01 §3.5）。不再「撤回 + 重新提交」。
   */
  const redeliver = useCallback(
    (deliverAs: QueuedDelivery) => {
      const target = nextLayer(last?.layer, deliverAs)
      if (pending || last === undefined || target === null) {
        return
      }
      setMoving(last)
      void queue.move(last.id, target).finally(() => {
        setMoving(undefined)
      })
    },
    [last, pending, queue],
  )

  const withdraw = useCallback(() => {
    if (last === undefined) {
      return
    }
    void queue.withdraw(last.id).then((restored) => {
      if (restored !== null) {
        onEdit(restored.text)
      }
    })
  }, [last, onEdit, queue])

  const toggle = useCallback(() => {
    setCollapsed((value) => !value)
  }, [])

  if (visible.length === 0) {
    return null
  }

  /*
   * 折叠头两行以上才画（正本同一条判据）：为一行再点一次头是白收一次 —— 那一行本来就
   * 摊着。列表长度是 agent 的出队顺序，它跑起来会自己变短，这一层不替它数。
   */
  const expanded = !collapsed
  const listVisible = visible.length === 1 || expanded
  const many = visible.length > 1

  return (
    <div className="prompt-queue" data-queue-dock>
      <div className="prompt-queue__panel">
        {many ? (
          <div className="prompt-queue__header">
            <button
              aria-controls="prompt-queue-list"
              aria-expanded={expanded}
              className="prompt-queue__summary"
              onClick={toggle}
              type="button"
            >
              <span aria-hidden className="prompt-queue__lead">
                <QueueGlyph />
              </span>
              <span className="prompt-queue__count">{visible.length} 条排队消息</span>
            </button>

            {/*
             * 两枚控件都改**最后那一条**（位置的产品选择；底层已支持任意一行），所以它们同
             * 在一处。把撤回单独留在最后一行上，读起来就是「只有这一行能删」的一枚孤零零
             * 的键 —— 那不是它的语义，它的语义是「撤回最后一条」。
             */}
            {last === undefined ? null : (
              <>
                <RowDeliveries current={last.layer} disabled={pending} onPick={redeliver} />
                <QueueAction disabled={pending} label="撤回最后一条，正文回输入框" onClick={withdraw}>
                  <TrashIcon aria-hidden size={14} />
                </QueueAction>
              </>
            )}

            {/* 折角放队尾：它只说「这一块能收起来」，夹在按钮中间会被当成第四枚操作。 */}
            <button
              aria-controls="prompt-queue-list"
              aria-expanded={expanded}
              aria-label={expanded ? '收起排队消息' : '展开排队消息'}
              className="prompt-queue__chevron"
              onClick={toggle}
              type="button"
            >
              {expanded ? <ChevronDownIcon size={14} /> : <ChevronUpIcon size={14} />}
            </button>
          </div>
        ) : null}

        <ul className="prompt-queue__list" hidden={!listVisible} id="prompt-queue-list">
          {listVisible
            ? visible.map((row) => (
                <li className="prompt-queue__row" key={row.id}>
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
                   * 一行时没有折叠头，两枚控件（换层 + 撤回）都贴这一行的右缘。
                   * 它们改的是最后一条，而这一行就是最后一条。
                   */}
                  {many || !row.last ? null : (
                    <>
                      <RowDeliveries current={row.layer} disabled={pending} onPick={redeliver} />
                      <QueueAction disabled={pending} label="撤回最后一条，正文回输入框" onClick={withdraw}>
                        <TrashIcon aria-hidden size={14} />
                      </QueueAction>
                    </>
                  )}
                </li>
              ))
            : null}
        </ul>
      </div>
    </div>
  )
})
