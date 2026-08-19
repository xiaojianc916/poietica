import type { QuestionTimelineItem } from '@poietica/agent'
import type { QuestionAnswerMethod, QuestionResponse } from '@poietica/agent-contract'
import { ChevronLeft, ChevronRight, Circle, CircleCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { answerOf, EMPTY_DRAFT, type QuestionDraft, responseOf } from './question-answer'

/*
 * 一整组题的面板。
 *
 * 一组题至多四道（协议上限），一次画一道：1/N 翻题。答复在凑齐之前不交出去 ——
 * 中途翻页不回任何东西，回出去的答复收不回来。
 *
 * 键盘：数字键挑选项（单选即挑、多选即勾），空格勾当前那一枚，回车等于底下那颗
 * 主按钮。method 如实上报：每一次挑选手势都盖过上一次，随答复送出去的是最近那次
 * 手势的通道 —— 官方今天不转发 'click'，那是上游的取舍，不是我们少记的理由。
 * 打字不算手势：method 的四档里没有它。
 *
 * 状态只有页码、草稿、备注与游标，全部跟着 key 走：换了题组，composer 换 key，
 * 整副面板重新挂载 —— 没有需要复位的 effect。
 */

/* 数字键到选项的下标。协议上限是四个选项，多出的键只是用不上。 */
const HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

export interface QuestionPanelProps {
  readonly item: QuestionTimelineItem
  readonly onAnswer?: ((response: QuestionResponse) => void) | undefined
  readonly onDismiss?: ((questionId: string) => void) | undefined
}

export function QuestionPanel({ item, onAnswer, onDismiss }: QuestionPanelProps) {
  const [page, setPage] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({})
  const [note, setNote] = useState('')
  const [cursor, setCursor] = useState(0)
  const [method, setMethod] = useState<QuestionAnswerMethod | undefined>(undefined)
  const [sent, setSent] = useState(false)

  const questions = item.questions
  const total = questions.length
  const current = questions[page] ?? questions[0]

  /* 协议保证至少一题；一份空载荷是上游的错，与方言无关，当场现形。 */
  if (current === undefined) {
    throw new Error('提问面板收到一组空题。')
  }

  const draft = drafts[current.id] ?? EMPTY_DRAFT
  const lastPage = page >= total - 1
  const ready = questions.every(
    (question) => answerOf(question, drafts[question.id] ?? EMPTY_DRAFT) !== undefined,
  )

  const edit = (next: QuestionDraft) => {
    setDrafts((held) => ({ ...held, [current.id]: next }))
  }

  /* 单选与自选互斥：勾了选项就清掉写下的字。多选不互斥，两样并立。 */
  const pick = (optionId: string, at: number, via: QuestionAnswerMethod) => {
    setCursor(at)
    setMethod(via)

    if (current.multiSelect === true) {
      edit({
        ...draft,
        skipped: false,
        picked: draft.picked.includes(optionId)
          ? draft.picked.filter((held) => held !== optionId)
          : [...draft.picked, optionId],
      })
      return
    }

    edit({
      ...draft,
      skipped: false,
      written: '',
      picked: draft.picked.includes(optionId) ? [] : [optionId],
    })
  }

  const write = (text: string) => {
    edit({
      ...draft,
      skipped: false,
      written: text,
      ...(current.multiSelect === true ? {} : { picked: [] }),
    })
  }

  const send = (via: QuestionAnswerMethod) => {
    const response = responseOf(item, drafts, method ?? via, note)

    if (response === undefined) {
      return
    }

    /* 先记下「交出去了」：questions_resolved 帧到达之前，所有控件都不该再点得动。 */
    setSent(true)
    onAnswer?.(response)
  }

  /* 主按钮：不是最后一页就翻页；最后一页凑齐了才是「交出答复」。 */
  const advance = (via: QuestionAnswerMethod) => {
    if (lastPage) {
      if (ready) {
        send(via)
      }
      return
    }

    setPage(page + 1)
    setCursor(0)
  }

  const turn = (delta: number) => {
    setPage((held) => Math.min(Math.max(held + delta, 0), total - 1))
    setCursor(0)
  }

  /*
   * 键盘挂在窗口上，不挂在某个输入框上：提问期间 textarea 不在场，全局监听不会
   * 打劫任何人的输入；两个文本格（自选、备注）聚焦时按键归它们，这里一律放行。
   * 每次渲染重挂一次，换来永远读到最新的闭包 —— 一副面板的生命以秒计。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (sent) {
        return
      }

      const target = event.target

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        advance('enter')
        return
      }

      if (event.key === ' ') {
        const option = current.options[cursor]

        if (option !== undefined) {
          event.preventDefault()
          pick(option.id, cursor, 'space')
        }
        return
      }

      const at = HOTKEYS.indexOf(event.key)
      const option = at < 0 ? undefined : current.options[at]

      if (option !== undefined) {
        event.preventDefault()
        pick(option.id, at, 'number_key')
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="assistant-question-panel">
      <div className="assistant-question-panel__inner">
        <div className="assistant-question-panel__page" key={current.id}>
          <div className="assistant-question-panel__head">
            <span className="assistant-question-panel__tag">{current.header ?? '提问'}</span>
            <span className="assistant-question-panel__count">
              {page + 1}/{total}
            </span>
            <button
              aria-label="撤下这组题"
              className="assistant-question-panel__dismiss"
              disabled={sent}
              onClick={() => onDismiss?.(item.questionId)}
              type="button"
            >
              <X size={14} />
            </button>
          </div>

          <p className="assistant-question-panel__prompt">{current.question}</p>

          {current.body === undefined ? null : (
            <p className="assistant-question-panel__body">{current.body}</p>
          )}

          <div
            className="assistant-question-panel__options"
            data-skipped={draft.skipped ? 'true' : undefined}
          >
            {current.options.map((option, at) => {
              const selected = draft.picked.includes(option.id)
              const Mark = selected ? CircleCheck : Circle

              return (
                <button
                  aria-pressed={selected}
                  className="assistant-question-panel__option"
                  data-cursor={at === cursor ? 'true' : undefined}
                  data-selected={selected ? 'true' : undefined}
                  disabled={sent}
                  key={option.id}
                  onClick={() => pick(option.id, at, 'click')}
                  title={option.description}
                  type="button"
                >
                  <span className="assistant-question-panel__key">{at + 1}</span>
                  <span className="assistant-question-panel__mark">
                    <Mark size={16} />
                  </span>
                  <span className="assistant-question-panel__label">{option.label}</span>
                </button>
              )
            })}
          </div>

          {current.allowOther === true ? (
            <input
              aria-label={current.otherLabel ?? '自己写一句'}
              className="assistant-question-panel__other"
              disabled={sent || draft.skipped}
              onChange={(event) => write(event.target.value)}
              placeholder={current.otherLabel ?? '其他…'}
              value={draft.written}
            />
          ) : null}

          {current.multiSelect === true ? (
            <p className="assistant-question-panel__hint-inline">可多选</p>
          ) : null}
        </div>

        <input
          aria-label="整组题的备注"
          className="assistant-question-panel__note"
          disabled={sent}
          onChange={(event) => setNote(event.target.value)}
          placeholder="备注（可选，随这组题一起送出）"
          value={note}
        />

        <div className="assistant-question-panel__foot">
          <div className="assistant-question-panel__nav">
            <button
              aria-label="上一题"
              className="assistant-question-panel__arrow"
              disabled={sent || page === 0}
              onClick={() => turn(-1)}
              type="button"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              aria-label="下一题"
              className="assistant-question-panel__arrow"
              disabled={sent || lastPage}
              onClick={() => turn(1)}
              type="button"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <span className="assistant-question-panel__hint">数字键选择，空格勾选，回车继续</span>

          <div className="assistant-question-panel__acts">
            <button
              className="assistant-question-panel__skip"
              disabled={sent}
              onClick={() => {
                setMethod('click')
                edit({ ...draft, skipped: !draft.skipped })
              }}
              type="button"
            >
              {draft.skipped ? '答这题' : '跳过这题'}
            </button>

            <button
              className={
                lastPage && !ready
                  ? 'assistant-question-panel__advance is-idle'
                  : 'assistant-question-panel__advance'
              }
              disabled={sent || (lastPage && !ready)}
              onClick={() => advance('click')}
              type="button"
            >
              {lastPage ? '交出答复' : '下一题'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
