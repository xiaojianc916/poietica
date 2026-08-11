import { ChevronLeft, ChevronRight, Circle, CircleCheck, X } from 'lucide-react'
import { useState } from 'react'

import type { QuestionAnswer, QuestionDeck } from '../semantics/ask-user-question'

/*
 * 输入框长出来的问答面板。
 *
 * 它不是浮层，也不是时间线里的卡片：composer 在有待答题组时整个换成它，答完再
 * 换回去。所以这里刻意不画外壳边框——外壳仍是 composer 自己那一层。
 *
 * 三层结构是为了那个「长」字：外层是单行 grid，行高从 0fr 撑到 1fr，中层裁掉
 * 溢出，内层才是内容。高度因此是被撑开的，不是先占好位再淡入——后者看起来是
 * 「浮现」，不是「长出来」。翻页时内层换 key，只淡入内容，外壳纹丝不动。
 *
 * 推进语义：点选项只落一个选中态，翻页要点"下一题"；箭头可回退改答；最后一题
 * 的按钮是"发送"，这时才把整组答案一次交出去。中途不回任何东西，因为 ACP 的
 * request_permission 一旦答了就收不回来，而用户要能改。
 *
 * 不 import 设计系统与 primitives：这一层要能在目录重排后原样存活。标准操作字形直接
 * 来自 lucide-react，与应用其余界面共享同一套几何和描边。
 */

function MarkIcon({ selected }: { readonly selected: boolean }) {
  const Mark = selected ? CircleCheck : Circle

  return <Mark aria-hidden="true" size={16} strokeWidth={1.5} />
}

/*
 * 整组跳过时，每题回它自己的 skipOptionId；没有 skip 的题不出现在结果里。
 *
 * 它此前是一个 useMemo。官方对 useMemo 的口径是「只有计算明显昂贵时才划算」，而这里是
 * 个位数张卡片的一次 flatMap —— memo 的净收益是负的：换来的是每次渲染一次依赖比较加
 * 一个闭包分配。而且它只在点「跳过全部」的那一刻才被读，压根不必每次渲染都算好等着。
 *
 * 同文件里的 collect() 是同构的派生，本来就是一个普通函数：一处 memo 一处不 memo，是
 * 同一条管线上的两种写法。
 */
function skipsOf(deck: QuestionDeck): readonly QuestionAnswer[] {
  return deck.cards.flatMap((entry) =>
    entry.skipOptionId === undefined
      ? []
      : [{ requestId: entry.requestId, optionId: entry.skipOptionId }],
  )
}

export interface QuestionPanelProps {
  readonly deck: QuestionDeck
  /**
   * 整组答案交出去。逐题一条，顺序与题组一致。
   *
   * 「发送」与「✕ 整组跳过」是同一个出口：两者的差别已经写在答案里 —— 跳过那一次
   * 每题回的是它自己的 skipOptionId，没有 skip 的题干脆不出现在结果里。此前这里是
   * 两个 prop，而调用点给它们的是同一个函数，外加两个内联箭头。
   */
  readonly onAnswer?: ((answers: readonly QuestionAnswer[]) => void) | undefined
}

export function QuestionPanel({ deck, onAnswer }: QuestionPanelProps) {
  const [index, setIndex] = useState(0)
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({})

  /*
   * 交出去之后不能再交第二次。
   *
   * ACP 的 request_permission 一答就收不回来，同一个 requestId 回两次是协议错误；
   * 而「发送」是个普通按钮，双击一下就是两次。此前挡这件事的是一个叫 busy 的 prop，
   * 写着「提交中：按钮转不可点，避免重复回包」—— 没有任何调用点传过它，那道闸从落地
   * 起就是敞开的。一个没人传、且缺席即缺陷的 prop，比没有更坏。
   *
   * 闸设在面板自己身上：它是唯一确切知道「我已经交出去了」的人，那一刻就是它调用
   * onAnswer 的那一刻，不必等上游把题组撤掉的那次往返。换了题组就是换了一个面板
   * （调用点按 toolCallId 给 key），这个闩跟着新实例从头开始。
   */
  const [sent, setSent] = useState(false)

  const total = deck.cards.length
  const card = deck.cards[Math.min(index, total - 1)]

  if (card === undefined) {
    return null
  }

  const chosen = picked[card.requestId]
  const isLast = index === total - 1

  const answer = (answers: readonly QuestionAnswer[]) => {
    if (sent) {
      return
    }

    setSent(true)
    onAnswer?.(answers)
  }

  /* 没选的题按跳过算，"下一题"不会把用户卡死在某一题上。 */
  const collect = (): readonly QuestionAnswer[] =>
    deck.cards.flatMap((entry) => {
      const optionId = picked[entry.requestId] ?? entry.skipOptionId

      return optionId === undefined ? [] : [{ requestId: entry.requestId, optionId }]
    })

  return (
    <section
      aria-label="来自助手的问题"
      className="assistant-question-panel"
      data-slot="question-panel"
    >
      <div className="assistant-question-panel__inner">
        <div className="assistant-question-panel__page" key={index}>
          <header className="assistant-question-panel__head">
            {card.header === '' ? null : (
              <span className="assistant-question-panel__tag">{card.header}</span>
            )}

            <p className="assistant-question-panel__prompt">{card.prompt}</p>

            <div className="assistant-question-panel__nav">
              <button
                aria-label="上一题"
                className="assistant-question-panel__arrow"
                disabled={index === 0}
                onClick={() => {
                  setIndex((current) => Math.max(0, current - 1))
                }}
                type="button"
              >
                <ChevronLeft aria-hidden="true" size={14} strokeWidth={1.5} />
              </button>

              <span className="assistant-question-panel__count">
                {index + 1}/{total}
              </span>

              <button
                aria-label="下一题"
                className="assistant-question-panel__arrow"
                disabled={isLast}
                onClick={() => {
                  setIndex((current) => Math.min(total - 1, current + 1))
                }}
                type="button"
              >
                <ChevronRight aria-hidden="true" size={14} strokeWidth={1.5} />
              </button>

              <button
                aria-label="跳过全部问题"
                className="assistant-question-panel__dismiss"
                disabled={sent}
                onClick={() => {
                  answer(skipsOf(deck))
                }}
                type="button"
              >
                <X aria-hidden="true" size={12} strokeWidth={1.5} />
              </button>
            </div>
          </header>

          <ul className="assistant-question-panel__options">
            {card.choices.map((choice) => (
              <li key={choice.optionId}>
                <button
                  aria-pressed={chosen === choice.optionId}
                  className="assistant-question-panel__option"
                  data-selected={chosen === choice.optionId ? 'true' : undefined}
                  disabled={sent}
                  onClick={() => {
                    setPicked((current) => ({ ...current, [card.requestId]: choice.optionId }))
                  }}
                  type="button"
                >
                  <span className="assistant-question-panel__mark">
                    <MarkIcon selected={chosen === choice.optionId} />
                  </span>

                  <span className="assistant-question-panel__label">{choice.label}</span>
                </button>
              </li>
            ))}
          </ul>

          <footer className="assistant-question-panel__foot">
            <span className="assistant-question-panel__hint">
              {chosen === undefined ? '未选择时按跳过处理' : ''}
            </span>

            <button
              className={`assistant-question-panel__advance${chosen === undefined ? ' is-idle' : ''}`}
              disabled={sent}
              onClick={() => {
                if (isLast) {
                  answer(collect())
                  return
                }

                setIndex((current) => Math.min(total - 1, current + 1))
              }}
              type="button"
            >
              {isLast ? '发送' : '下一题'}
            </button>
          </footer>
        </div>
      </div>
    </section>
  )
}
