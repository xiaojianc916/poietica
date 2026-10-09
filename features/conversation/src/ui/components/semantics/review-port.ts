import type { DiffFile } from './unified-diff'

/*
 * 工具卡片画 diff 需要的那几件。
 *
 * 语义层（unified-diff.ts）是 legacy review 的逐字迁移；这里只剩「着色」这一格，
 * 以及 DiffBody 的兜底实现（见 diff-body.tsx）。
 */
export {
  basename,
  computeFile,
  type DiffFile,
  type DiffRow,
  type DiffRowKind,
  type DiffStat,
  diffStatOf,
  toDisplayPath,
} from './unified-diff'

/** legacy review/surface 的 paint()：着色交给 shiki，P5 不引（行模型原样交回） */
export function paint(files: readonly DiffFile[]): Promise<readonly DiffFile[]> {
  return Promise.resolve(files)
}
