import { Fragment, type ReactNode, useState } from 'react'
import { PromptChip, promptSegments } from '../../shared/primitives/prompt-chip'
import type { MessageFile, MessageImage } from '../../shared/timeline/timeline-contract'
import { MessageAttachments } from './message-attachments'
import { VirtualLines } from './virtual-lines'

import './user-message.css'

/*
 * 太长就在气泡里自己滚，不再给「展开全部」：滚动条说的是「这里还有」，折叠带说的是「这里有东西被藏了」，
 * 而人想知道的是前一句。判据只剩行数 —— 话怎么读由行决定，字数不是人读的单位。
 *
 * 7 是从上限反推的：--cp-timeline-said-max（10.5rem = 168px）÷ 行高（0.875rem × 1.65 ≈ 23.1px）≈ 7.27 行。
 * 再小会让 8 行的话默认被裁掉一截却没有滚动条；再大则 8 行以内的话平白出现滚动条。
 */
const SCROLL_ABOVE_LINES = 7

/** 超过这么多行就虚拟化：粘进来的整份文档不该整段进 DOM（与工具输出面板同一条判据）。 */
export const USER_VIRTUAL_ABOVE_LINES = 50

/*
 * 与 row-estimate.ts 同一条规矩：--ui-prose-size（0.875rem）× --ui-prose-line-height（1.65）≈ 23.1px 是正本，这里是它的读数。
 * 折行后的真高交给虚拟器量（measured），这个数只当估高；偏一点只影响滚动条总长，不会错位。
 */
const USER_LINE_PX = 23.1

/** @mcp 记号的写法只有 promptSegments 这一对读写处，这里只负责把段落变成节点。 */
function inlineOf(text: string, keyPrefix: string): readonly ReactNode[] {
  return promptSegments(text).map((segment, at) =>
    segment.kind === 'text' ? (
      <Fragment key={`${keyPrefix}-${String(at)}`}>{segment.text}</Fragment>
    ) : (
      <PromptChip key={`${keyPrefix}-${String(at)}`} kind="mcp" name={segment.name} />
    ),
  )
}

/** 技能与文件在输入框里就是正文里的一枚记号：发出去之后画成气泡里的同一枚记号。 */
function chipsOf(files: readonly MessageFile[], skills: readonly string[]): readonly ReactNode[] {
  return [
    ...skills.map((name) => <PromptChip key={`skill-${name}`} kind="skill" name={name} />),
    ...files.map((file, at) => <PromptChip key={`file-${String(at)}-${file.name}`} kind="file" name={file.name} />),
  ]
}

/**
 * 绝不走 markdown：渲染用户的话会让他们自己的文本改变显示方式，也会让粘贴进来的一份文档改写这段对话。
 * 图片与气泡是两个兄弟节点：塞进气泡就是把气泡撑成图片框。文件不一样 —— 它在输入框里就是正文里的一枚记号，
 * 发出去之后也画成气泡里的同一枚记号（排在技能之后、原文之前），人看到的就是自己写下的那一句。
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
  return (
    <>
      {(images?.length ?? 0) > 0 ? <MessageAttachments images={images} /> : null}
      <Said files={files ?? []} skills={skills ?? []} text={text} undelivered={undelivered === true} />
    </>
  )
}

/** 与 `UserMessage` 分开只为：附件与气泡是两个兄弟，合在一个函数里条件会叠在一起，复杂度闸门过不去。 */
function Said({
  files,
  skills,
  text,
  undelivered,
}: {
  readonly files: readonly MessageFile[]
  readonly skills: readonly string[]
  readonly text: string
  readonly undelivered: boolean
}) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null)
  const lines = text.split('\n')
  const long = lines.length > SCROLL_ABOVE_LINES
  const chips = chipsOf(files, skills)

  if (text.length === 0 && skills.length === 0 && files.length === 0) {
    return null
  }

  return (
    <div
      className="timeline-user"
      data-long={long ? 'true' : undefined}
      data-undelivered={undelivered ? 'true' : undefined}
    >
      {lines.length >= USER_VIRTUAL_ABOVE_LINES ? (
        <>
          {/* 记号在滚动盒外面：虚拟器只铺视口附近，跟着行走就会随滚动消失。 */}
          {chips.length > 0 ? <p className="timeline-user__chips">{chips}</p> : null}
          <div className="timeline-user__text" data-scrollable="" ref={setViewport}>
            <VirtualLines
              className="timeline-user__output"
              lineClassName="timeline-user__line"
              lineHeight={USER_LINE_PX}
              lines={lines}
              measured
              viewport={viewport}
            />
          </div>
        </>
      ) : (
        <p className="timeline-user__text" data-scrollable={long ? '' : undefined}>
          {chips}
          {inlineOf(text, 'said')}
        </p>
      )}
    </div>
  )
}
