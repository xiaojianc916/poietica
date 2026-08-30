import { basename, computeFile, type DiffFile, toDisplayPath } from '@poietica/review'

export { basename, toDisplayPath }

import type { ToolContentPart } from './tool-call-content'

/**
 * 工具调用的载荷 → 一处改动。
 *
 * 行怎么切、行号怎么编、折叠怎么算都在 @poietica/review，全仓一条管线；这一层只做
 * 「协议片段 → 那条管线的入参」这一次投影，并按片段数组记一次账。
 */

const NONE: readonly DiffFile[] = []

const FILES = new WeakMap<readonly ToolContentPart[], readonly DiffFile[]>()

/**
 * 这一面里的每一处改动，按片段数组记一次。
 *
 * 键是投影交回的那个数组，它的引用由 toToolContentParts 的记账保证稳定，所以同一份内容
 * 不会被比对两遍 —— Myers 差分不便宜，而这条路在渲染路径上。
 */
export function toDiffFiles(parts: readonly ToolContentPart[]): readonly DiffFile[] {
  const held = FILES.get(parts)

  if (held !== undefined) {
    return held
  }

  const files: DiffFile[] = []

  for (const part of parts) {
    if (part.type === 'diff') {
      const file = computeFile(toDisplayPath(part.path), part.oldText ?? '', part.newText)

      /* 前后一模一样：没有一行可画，这次调用也就不是一处改动。 */
      if (file.rows.length > 0) {
        files.push(file)
      }
    }
  }

  const found: readonly DiffFile[] = files.length === 0 ? NONE : files

  FILES.set(parts, found)

  return found
}
