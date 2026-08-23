import './outcome-card.css'

import { Surface } from '../primitives/surface'
import { Prose } from './prose'

/**
 * 一件落定的事，和它的结局。
 *
 * 三个槽，没有第四个：题面说当时问的是什么，结局说最后怎么了，附注留给「没答」
 * 「已取消」这类既不是题也不是答的话。层级全部由字号与墨色承担，卡片本身不带
 * 强调色。
 *
 * 它不认识提问，也不认识权限请求 —— 谁是题、谁是答由调用方回答，这里只负责让
 * 两者在流里长成同一个样子。
 */

export interface OutcomeCardProps {
  readonly prompt: string
  readonly answer?: string | undefined
  readonly note?: string | undefined
  readonly answered?: boolean | undefined
}

export function OutcomeCard({ answer, answered, note, prompt }: OutcomeCardProps) {
  return (
    <Surface className="assistant-outcome" data-answered={answered === true ? 'true' : undefined}>
      {/*
       * 题面可能是一整份文档。
       *
       * 权限那边答复之后传进来的 prompt 是 askedOf()，它的第一条分支就是这次
       * 调用自己说的那段话 —— 计划模式下那是一份完整的 markdown。所以题面和
       * 流里其它任何一段 markdown 走同一个组件，而不是被塞进一个 <p> 里当作
       * 一行纯文本。结局与附注不走：它们是一个选项的名字，不是文档。
       */}
      <Prose className="assistant-outcome__prompt" isStreaming={false} text={prompt} />

      {answer === undefined ? null : <p className="assistant-outcome__answer">{answer}</p>}

      {note === undefined ? null : <p className="assistant-outcome__note">{note}</p>}
    </Surface>
  )
}
