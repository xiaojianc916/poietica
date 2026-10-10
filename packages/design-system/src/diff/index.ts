/*
 * 行带的无头那一半：行模型（unified-diff.ts）与语法着色（syntax.ts / highlighter.ts）。
 *
 * 这一条子路径不引 React、不引样式 —— review 的 worker（derive.worker.ts）在 worker
 * 线程里跑同一条管线，那里没有 DOM 也没有 React。画的那一半在 `./surface`。
 */
export { paint } from './syntax'
export {
  basename,
  computeFile,
  type DiffFile,
  type DiffPiece,
  type DiffRow,
  type DiffRowKind,
  type DiffStat,
  diffStatOf,
  parseUnifiedPatch,
  toDisplayPath,
} from './unified-diff'
