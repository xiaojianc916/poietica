import type { MessageImage } from '@poietica/agent'
import { useState } from 'react'
import { PromptChip, promptSegments } from '../composer/prompt-chip'
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
 * 只有图、没有话也没有记号时，气泡整个不出现。不是空气泡，也不替人补一句「[图片]」：
 * 没说的话不该由界面替他说。
 */
export function UserMessage({
  images,
  skills,
  text,
}: {
  readonly images?: readonly MessageImage[] | undefined
  readonly skills?: readonly string[] | undefined
  readonly text: string
}) {
  const [expanded, setExpanded] = useState(false)
  const long = isLong(text)
  const attached = skills ?? []

  return (
    <>
      {images === undefined || images.length === 0 ? null : <MessageAttachments images={images} />}

      {text.length === 0 && attached.length === 0 ? null : (
        <div className="timeline-user" data-clamped={long && !expanded ? 'true' : undefined}>
          <p className="timeline-user__text">
            {attached.map((name) => (
              <PromptChip key={`skill-${name}`} kind="skill" name={name} />
            ))}
            {promptSegments(text).map((segment, at) =>
              segment.kind === 'text' ? (
                segment.text
              ) : (
                <PromptChip
                  key={`mcp-${String(at)}-${segment.name}`}
                  kind="mcp"
                  name={segment.name}
                />
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
      )}
    </>
  )
}
