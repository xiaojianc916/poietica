import './live-process.css'

import type { FeedRow } from '@poietica/agent'
import { memo, type ReactNode } from 'react'

/**
 * 这一段还没有结论的工作。
 *
 * 它坐在转录尾部，也就是虚拟器 paddingEnd 预留出来的那块空间里，因此仍然跟着一起
 * 滚，而它的内容不在虚拟器的条目表内 —— 换掉一帧不改变任何一行的身份，也不作废任何
 * 一行的实测高度。这是它存在的全部理由：过程若走 rows，一轮之内就必然有一次中段
 * 删除，而那一次删除就是屏幕上内容整段消失又出现。
 *
 * 范围由 turn-fold.ts 给出，不在这里判：只有「最后一段回复之后」的过程帧会进来。所以
 * 这里没有上限、没有内嵌滚动、也没有自动滚底 —— 模型说完一句话，之前那段工作已经归
 * 封条了，它不该还留在「现在正在做」里。
 *
 * 行怎么画同样不在这里判：renderRow 是转录用的那一个，两条通道因此长同一个样子，
 * 一帧从这里被封条收走时不会换外观。
 */
export interface LiveProcessProps {
  readonly rows: readonly FeedRow[]
  readonly renderRow: (row: FeedRow) => ReactNode
}

export const LiveProcess = memo(function LiveProcess({ renderRow, rows }: LiveProcessProps) {
  if (rows.length === 0) {
    return null
  }

  return (
    <div className="live-process">
      {rows.map((row) => (
        <div className="live-process__frame" key={row.item.id}>
          {renderRow(row)}
        </div>
      ))}
    </div>
  )
})
