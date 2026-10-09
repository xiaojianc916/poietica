import { useState } from 'react'
import type { MessageFile, MessageImage } from '../../timeline/timeline-contract'
import { PromptChip, promptSegments } from '../primitives/prompt-chip'
import { MessageAttachments } from './message-attachments'

/*
 * A long message is clipped, and the clip can be released.
 *
 * A nested scroller inside a scrolling transcript is the wrong answer twice: it
 * traps the wheel, and it hides where the message ends. Clipping with a fade
 * says the same thing and leaves exactly one scrollbar on screen.
 *
 * Whether to clip is decided from the text, not from the layout. One value
 * drives both the clamp and the control, so a button can never appear over a
 * message that was never clipped — the two cannot disagree.
 */
const CLAMP_CHARS = 420
const CLAMP_LINES = 9

function isLong(text: string): boolean {
  return text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES
}

/**
 * What the person said, exactly as they typed it.
 *
 * Never markdown: rendering a user message would let their own text change how
 * it is displayed, and would let a pasted document rewrite the conversation.
 *
 * 附件排在气泡外面、气泡上面，两个兄弟节点。图片不是那句话的一部分：气泡的
 * 宽度贴着文字，把一排图塞进去就是把气泡撑成一个图片框。行的高度不用谁来
 * 声明 —— feed 用 measureElement 真量，估高只管首屏。
 *
 * 只有附件、没有话也没有记号时，气泡整个不出现。不是空气泡，也不替人补一句「[附件]」：
 * 没说的话不该由界面替他说。
 */
export function UserMessage({
  files,
  images,
  skills,
  text,
  undelivered,
}: {
  readonly files?: readonly MessageFile[] | undefined
  readonly images?: readonly MessageImage[] | undefined
  readonly skills?: readonly string[] | undefined
  readonly text: string
  /**
   * 这一句没有被 agent 收到（R-08-5）：Core 重启带走了 omp 的内存队列。
   *
   * 画成虚线而不是换一套颜色：它仍然是人说过的话，只是没有送达 —— 染成失败色会让人
   * 以为这句话本身错了。补救入口在输入区上沿的失败横幅（「取回文字」）。
   */
  readonly undelivered?: boolean | undefined
}) {
  const hasAttachments = (files?.length ?? 0) > 0 || (images?.length ?? 0) > 0

  return (
    <>
      {hasAttachments ? <MessageAttachments files={files} images={images} /> : null}
      <Said text={text} skills={skills ?? []} undelivered={undelivered === true} />
    </>
  )
}

/**
 * 那句话本身：气泡、技能记号、正文，以及太长时的收起/展开。
 *
 * 与 `UserMessage` 分开只为一件事：附件那一块与气泡那一块是**两个兄弟**（见上），
 * 合在一个函数里两件事的条件会叠在一起，复杂度闸门就过不去了。
 */
function Said({
  skills,
  text,
  undelivered,
}: {
  readonly skills: readonly string[]
  readonly text: string
  readonly undelivered: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const long = isLong(text)

  /* 只有附件、没有话也没有记号时，气泡整个不出现（上面那条头注）。 */
  if (text.length === 0 && skills.length === 0) {
    return null
  }

  return (
    <div
      className="timeline-user"
      data-clamped={long && !expanded ? 'true' : undefined}
      data-undelivered={undelivered ? 'true' : undefined}
    >
      <p className="timeline-user__text">
        {skills.map((name) => (
          <PromptChip key={`skill-${name}`} kind="skill" name={name} />
        ))}
        {promptSegments(text).map((segment, at) =>
          segment.kind === 'text' ? (
            segment.text
          ) : (
            <PromptChip key={`mcp-${String(at)}-${segment.name}`} kind="mcp" name={segment.name} />
          ),
        )}
      </p>

      {long ? (
        <button
          className="timeline-user__more"
          onClick={() => {
            setExpanded(!expanded)
          }}
          type="button"
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      ) : null}
    </div>
  )
}
