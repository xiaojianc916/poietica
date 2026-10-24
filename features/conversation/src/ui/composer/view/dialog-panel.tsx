import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@poietica/design-system'
import { invariant } from '@poietica/foundation'
import { Circle, CircleCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DialogAnswer, DialogRequest } from '../../shared/model/dialog'
import type { QuestionTimelineItem } from '../../shared/timeline/timeline-contract'

/*
 * 单问面板（Q1-E）：确认 / 单选 / 输入各一张卡，长在输入框里、样子借提问面板（同一套 class）。
 * 与题组不同：只有一道、不翻页、没有「跳过」与备注 —— 上游要的就是一个布尔、一条原文或一句话。
 * 答复按单问自己的种类交出去；撤下走题组那条 dismiss。
 */

const HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

const TAG: Record<DialogRequest['kind'], string> = { confirm: '确认', select: '选择', input: '输入' }

export interface DialogPanelProps {
  readonly item: QuestionTimelineItem
  readonly onAnswer?: ((interactionId: string, answer: DialogAnswer) => Promise<void>) | undefined
  readonly onDismiss?: ((interactionId: string) => Promise<void>) | undefined
}

export function DialogPanel({ item, onAnswer, onDismiss }: DialogPanelProps) {
  const dialog = item.dialog
  if (dialog === undefined) {
    invariant(false, '单问面板收到的是一组题。')
  }

  /* editor 发来的「预填」落在 placeholder 那一格：多行时它是正文的起点，单行时只是提示 */
  const [text, setText] = useState(dialog.kind === 'input' && dialog.multiline ? (dialog.placeholder ?? '') : '')
  const [picked, setPicked] = useState<number | undefined>(undefined)
  const [sent, setSent] = useState(false)

  const deliver = (action: () => Promise<void>) => {
    setSent(true)
    void Promise.resolve()
      .then(action)
      .catch(() => {
        setSent(false)
      })
  }

  const answer = (value: DialogAnswer) => {
    if (onAnswer === undefined) return
    deliver(() => onAnswer(item.questionId, value))
  }

  const dismiss = () => {
    if (onDismiss === undefined) return
    deliver(() => onDismiss(item.questionId))
  }

  /* 主键交出的那一份；单选还没选时交不出 */
  const primary = (): DialogAnswer | undefined => {
    if (dialog.kind === 'confirm') return { kind: 'confirm', value: true }
    if (dialog.kind === 'input') return { kind: 'input', value: text }
    const label = picked === undefined ? undefined : dialog.options[picked]
    return label === undefined ? undefined : { kind: 'select', value: label }
  }
  const ready = primary() !== undefined

  const submit = () => {
    const value = primary()
    if (value !== undefined) answer(value)
  }

  useDialogHotkeys({ dialog, sent, onPick: setPicked, onSubmit: submit })

  return (
    <div className="assistant-question-panel" data-dialog={dialog.kind}>
      <div className="assistant-question-panel__inner">
        <div className="assistant-question-panel__page">
          <div className="assistant-question-panel__head">
            <span className="assistant-question-panel__tag">{TAG[dialog.kind]}</span>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  aria-label="撤下这一问"
                  className="assistant-question-panel__dismiss"
                  disabled={sent}
                  onClick={dismiss}
                  type="button"
                >
                  <X aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  撤下这一问
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          <p className="assistant-question-panel__prompt">{dialog.title}</p>

          {dialog.kind === 'confirm' && dialog.message !== '' ? (
            <p className="assistant-question-panel__body">{dialog.message}</p>
          ) : null}

          {dialog.kind === 'select' ? (
            <div className="assistant-question-panel__options">
              {dialog.options.map((label, at) => {
                const selected = picked === at
                const Mark = selected ? CircleCheck : Circle
                return (
                  <button
                    aria-pressed={selected}
                    className="assistant-question-panel__option"
                    data-selected={selected ? 'true' : undefined}
                    disabled={sent}
                    /* 选项原文可能重复：位置才是它的身份 */
                    key={at}
                    onClick={() => setPicked(selected ? undefined : at)}
                    type="button"
                  >
                    <span className="assistant-question-panel__key">{at + 1}</span>
                    <span className="assistant-question-panel__mark">
                      <Mark aria-hidden="true" />
                    </span>
                    <span className="assistant-question-panel__label">{label}</span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {dialog.kind === 'input' ? (
            <div className="assistant-question-panel__option assistant-question-panel__option--other assistant-dialog-panel__field">
              {dialog.multiline ? (
                <textarea
                  aria-label={dialog.title}
                  className="assistant-question-panel__other-input assistant-dialog-panel__text"
                  disabled={sent}
                  onChange={(event) => setText(event.target.value)}
                  rows={4}
                  value={text}
                />
              ) : (
                <input
                  aria-label={dialog.title}
                  className="assistant-question-panel__other-input"
                  disabled={sent}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      submit()
                    }
                  }}
                  placeholder={dialog.placeholder ?? '请输入…'}
                  value={text}
                />
              )}
            </div>
          ) : null}
        </div>

        <div className="assistant-question-panel__tail">
          <div className="assistant-question-panel__foot">
            <span />
            <div className="assistant-question-panel__acts">
              {dialog.kind === 'confirm' ? (
                <Button
                  disabled={sent}
                  onClick={() => answer({ kind: 'confirm', value: false })}
                  size="sm"
                  type="button"
                  variant="soft"
                >
                  不确认
                </Button>
              ) : null}

              <Button disabled={sent || !ready} onClick={submit} size="sm" type="button">
                {dialog.kind === 'confirm' ? '确认' : '提交'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Enter 交主键、数字键选第几项；文本框里的按键归文本框。 */
function useDialogHotkeys(args: {
  readonly dialog: DialogRequest
  readonly sent: boolean
  readonly onPick: (at: number) => void
  readonly onSubmit: () => void
}): void {
  const { dialog, sent, onPick, onSubmit } = args
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (sent) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (event.key === 'Enter') {
        event.preventDefault()
        onSubmit()
        return
      }
      const at = HOTKEYS.indexOf(event.key)
      if (dialog.kind === 'select' && at >= 0 && at < dialog.options.length) {
        event.preventDefault()
        onPick(at)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}
