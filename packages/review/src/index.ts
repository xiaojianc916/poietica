/* 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。 */

export {
  type ChangeTreeFile,
  type ChangeTreeFolder,
  changeTreeRows,
} from './change-tree.ts'
export type { ReviewFailureCode, ReviewFailureReport, ReviewGateway } from './review-gateway.ts'
export type {
  ReviewPaint,
  ReviewPresentation,
  ReviewReading,
  ReviewState,
  ReviewStore,
  ReviewSwitch,
} from './review-store.ts'
export {
  createReviewStore,
  TREE_MAX,
  TREE_MIN,
  WORKTREE_BASE,
} from './review-store.ts'
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
