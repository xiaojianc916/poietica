/* 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。 */

export type {
  DiffFile,
  DiffPiece,
  DiffRow,
  DiffRowKind,
  DiffStat,
  PieceColor,
} from './unified-diff.ts'
export {
  basename,
  computeFile,
  diffStatOf,
  parseUnifiedPatch,
  toDisplayPath,
} from './unified-diff.ts'
