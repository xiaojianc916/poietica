import type {
  QuestionAnswerMethod,
  QuestionResponse,
  QuestionTimelineItem,
} from '@poietica/conversation'
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@poietica/design-system'
import { ChevronLeft, ChevronRight, Circle, CircleCheck, X } from 'lucide-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { answerOf, EMPTY_DRAFT, type QuestionDraft, responseOf } from './question-answer'

/*
 * 一组题一次只画一道，全部答完或跳过后才提交。
 * 数字键、空格与回车仍可操作；最后一次选择手势随答复上报。
 * 面板状态随题组 key 重建，QuestionResponse 只由 responseOf 生成。
 */

/* 数字键覆盖协议选项和末尾的“其他”。 */
const HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

type QuestionItem = QuestionTimelineItem['questions'][number]
type QuestionOption = QuestionItem['options'][number]

type KeyIntent =
  | { readonly kind: 'advance' }
  | { readonly kind: 'focus_other' }
  | {
      readonly kind: 'pick'
      readonly at: number
      readonly option: QuestionOption
      readonly via: QuestionAnswerMethod
    }

/** 文本输入拥有按键；其余按键映射为面板意图。 */
function keyIntentOf(
  event: KeyboardEvent,
  options: readonly QuestionOption[],
  cursor: number,
  allowOther: boolean,
): KeyIntent | undefined {
  const target = event.target

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return undefined
  }

  if (event.key === 'Enter') {
    return { kind: 'advance' }
  }

  const space = event.key === ' '
  const at = space ? cursor : HOTKEYS.indexOf(event.key)

  if (allowOther && at === options.length) {
    return { kind: 'focus_other' }
  }

  const option = at < 0 ? undefined : options[at]

  if (option === undefined) {
    return undefined
  }

  return { kind: 'pick', at, option, via: space ? 'space' : 'number_key' }
}

function togglePicked(picked: readonly string[], optionId: string): string[] {
  return picked.includes(optionId)
    ? picked.filter((held) => held !== optionId)
    : [...picked, optionId]
}

/* 单选与自选互斥；多选允许普通选项与“其他”并立。 */
function draftForPick(draft: QuestionDraft, optionId: string, multiSelect: boolean): QuestionDraft {
  if (multiSelect) {
    return { ...draft, skipped: false, picked: togglePicked(draft.picked, optionId) }
  }
  return {
    ...draft,
    skipped: false,
    written: '',
    picked: draft.picked.includes(optionId) ? [] : [optionId],
  }
}

function draftForWrite(draft: QuestionDraft, text: string, multiSelect: boolean): QuestionDraft {
  return {
    ...draft,
    skipped: false,
    written: text,
    ...(multiSelect ? {} : { picked: [] }),
  }
}

function allAnswered(
  questions: readonly QuestionItem[],
  drafts: Readonly<Record<string, QuestionDraft>>,
): boolean {
  return questions.every(
    (question) => answerOf(question, drafts[question.id] ?? EMPTY_DRAFT) !== undefined,
  )
}

function useQuestionHotkeys(args: {
  readonly sent: boolean
  readonly current: QuestionItem
  readonly cursor: number
  readonly onAdvance: () => void
  readonly onFocusOther: () => void
  readonly onPick: (optionId: string, at: number, via: QuestionAnswerMethod) => void
}): void {
  const { sent, current, cursor, onAdvance, onFocusOther, onPick } = args
  /* 监听绑定在题组生命周期内；文本输入由 keyIntentOf 排除。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const intent = sent
        ? undefined
        : keyIntentOf(event, current.options, cursor, current.allowOther)
      if (intent === undefined) {
        return
      }
      event.preventDefault()
      if (intent.kind === 'advance') {
        onAdvance()
        return
      }
      if (intent.kind === 'focus_other') {
        onFocusOther()
        return
      }
      onPick(intent.option.id, intent.at, intent.via)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

function QuestionOptionList({
  current,
  draft,
  sent,
  onPick,
  onWrite,
  onFocusOther,
  otherInput,
}: {
  readonly current: QuestionItem
  readonly draft: QuestionDraft
  readonly sent: boolean
  readonly onPick: (optionId: string, at: number) => void
  readonly onWrite: (text: string) => void
  readonly onFocusOther: () => void
  readonly otherInput: RefObject<HTMLInputElement | null>
}) {
  const otherSelected = draft.written.trim().length > 0
  const OtherMark = otherSelected ? CircleCheck : Circle
  return (
    <>
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
              data-selected={selected ? 'true' : undefined}
              disabled={sent}
              key={option.id}
              onClick={() => onPick(option.id, at)}
              title={option.description}
              type="button"
            >
              <span className="assistant-question-panel__key">{at + 1}</span>
              <span className="assistant-question-panel__mark">
                <Mark aria-hidden="true" size={16} />
              </span>
              <span className="assistant-question-panel__label">{option.label}</span>
            </button>
          )
        })}
        {current.allowOther === true ? (
          <label
            className="assistant-question-panel__option assistant-question-panel__option--other"
            data-disabled={sent || draft.skipped ? 'true' : undefined}
            data-selected={otherSelected ? 'true' : undefined}
          >
            <span className="assistant-question-panel__key">{current.options.length + 1}</span>
            <span className="assistant-question-panel__mark">
              <OtherMark aria-hidden="true" size={16} />
            </span>
            <span className="assistant-question-panel__label">{current.otherLabel ?? '其他'}</span>
            <input
              aria-label={current.otherLabel ?? '其他'}
              className="assistant-question-panel__other-input"
              disabled={sent || draft.skipped}
              onChange={(event) => onWrite(event.target.value)}
              onFocus={onFocusOther}
              placeholder={current.otherDescription ?? '请输入…'}
              ref={otherInput}
              value={draft.written}
            />
          </label>
        ) : null}
      </div>
      {current.multiSelect === true ? (
        <p className="assistant-question-panel__hint-inline">可多选</p>
      ) : null}
    </>
  )
}

export interface QuestionPanelProps {
  readonly item: QuestionTimelineItem
  readonly onAnswer?: ((response: QuestionResponse) => Promise<void>) | undefined
  readonly onDismiss?: ((questionId: string) => Promise<void>) | undefined
}

export function QuestionPanel({ item, onAnswer, onDismiss }: QuestionPanelProps) {
  const [page, setPage] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({})
  const [note, setNote] = useState('')
  const [cursor, setCursor] = useState(0)
  const [method, setMethod] = useState<QuestionAnswerMethod | undefined>(undefined)
  const [sent, setSent] = useState(false)
  const otherInput = useRef<HTMLInputElement>(null)

  const questions = item.questions
  const total = questions.length
  const current = questions[page] ?? questions[0]

  if (current === undefined) {
    throw new Error('提问面板收到一组空题。')
  }

  const draft = drafts[current.id] ?? EMPTY_DRAFT
  const lastPage = page >= total - 1
  const ready = allAnswered(questions, drafts)

  const edit = (next: QuestionDraft) => {
    setDrafts((held) => ({ ...held, [current.id]: next }))
  }

  const pick = (optionId: string, at: number, via: QuestionAnswerMethod) => {
    setCursor(at)
    setMethod(via)
    edit(draftForPick(draft, optionId, current.multiSelect === true))
  }

  const write = (text: string) => {
    edit(draftForWrite(draft, text, current.multiSelect === true))
  }

  const deliver = (action: () => Promise<void>) => {
    setSent(true)
    void Promise.resolve()
      .then(action)
      .catch(() => {
        setSent(false)
      })
  }

  const send = (via: QuestionAnswerMethod) => {
    const response = responseOf(item, drafts, method ?? via, note)
    if (response === undefined || onAnswer === undefined) {
      return
    }
    deliver(() => onAnswer(response))
  }

  const dismiss = () => {
    if (onDismiss === undefined) {
      return
    }
    deliver(() => onDismiss(item.questionId))
  }

  const advance = (via: QuestionAnswerMethod) => {
    if (!lastPage) {
      setPage(page + 1)
      setCursor(0)
      return
    }
    if (ready) {
      send(via)
    }
  }

  const turn = (delta: number) => {
    setPage((held) => Math.min(Math.max(held + delta, 0), total - 1))
    setCursor(0)
  }

  const focusOther = () => {
    setCursor(current.options.length)
    otherInput.current?.focus()
  }

  useQuestionHotkeys({
    sent,
    current,
    cursor,
    onAdvance: () => advance('enter'),
    onFocusOther: focusOther,
    onPick: (optionId, at, via) => pick(optionId, at, via),
  })

  return (
    <div className="assistant-question-panel">
      <div className="assistant-question-panel__inner">
        <div className="assistant-question-panel__page" key={current.id}>
          <div className="assistant-question-panel__head">
            <span className="assistant-question-panel__count">
              {page + 1}/{total}
            </span>
            <span className="assistant-question-panel__tag">{current.header ?? '提问'}</span>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  aria-label="撤下这组题"
                  className="assistant-question-panel__dismiss"
                  disabled={sent}
                  onClick={dismiss}
                  type="button"
                >
                  <X aria-hidden="true" size={14} />
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  撤下这组题
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          <p className="assistant-question-panel__prompt">{current.question}</p>

          {current.body === undefined ? null : (
            <p className="assistant-question-panel__body">{current.body}</p>
          )}

          <QuestionOptionList
            current={current}
            draft={draft}
            onFocusOther={() => setCursor(current.options.length)}
            onPick={(optionId, at) => pick(optionId, at, 'click')}
            onWrite={write}
            otherInput={otherInput}
            sent={sent}
          />
        </div>

        <div className="assistant-question-panel__tail">
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
                <ChevronLeft aria-hidden="true" size={16} />
              </button>
              <button
                aria-label="下一题"
                className="assistant-question-panel__arrow"
                disabled={sent || lastPage}
                onClick={() => turn(1)}
                type="button"
              >
                <ChevronRight aria-hidden="true" size={16} />
              </button>
            </div>

            <div className="assistant-question-panel__acts">
              <Button
                disabled={sent}
                onClick={() => {
                  setMethod('click')
                  edit({ ...draft, skipped: !draft.skipped })
                }}
                size="sm"
                type="button"
                variant="soft"
              >
                {draft.skipped ? '答这题' : '跳过这题'}
              </Button>

              <Button
                disabled={sent || (lastPage && !ready)}
                onClick={() => advance('click')}
                size="sm"
                type="button"
              >
                {lastPage ? '提交' : '下一题'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
