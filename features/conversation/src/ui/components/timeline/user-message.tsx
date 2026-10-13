import { useState } from 'react'
import type { MessageFile, MessageImage } from '../../timeline/timeline-contract'
import { PromptChip, promptSegments } from '../primitives/prompt-chip'
import { MessageAttachments } from './message-attachments'

import './user-message.css'

/*
 * 一道淡出而不是嵌套滚动盒：嵌在滚动中的转录里会吃掉滚轮、也看不出消息到哪儿结束。裁剪与否由文本决定，所以一个值同时驱动折叠与那颗键。
 */
const CLAMP_CHARS = 420
const CLAMP_LINES = 9

function isLong(text: string): boolean {
  return text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES
}

/**
 * 绝不走 markdown：渲染用户的话会让他们自己的文本改变显示方式，也会让粘贴进来的一份文档改写这段对话。
 * 附件与气泡是两个兄弟节点：塞进气泡就是把气泡撑成图片框。
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
  /** 这一句没有被 agent 收到（R-08-5）：Core 重启带走了 omp 的内存队列。 */
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

/** 与 `UserMessage` 分开只为：附件与气泡是两个兄弟，合在一个函数里条件会叠在一起，复杂度闸门过不去。 */
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
