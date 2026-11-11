/*
 * 统一 diff 的纯逻辑：一份补丁、或一对正文 → 行模型。
 *
 * 切 hunk、编行号、算词级差分交给 jsdiff（unified format 是 GNU diffutils 定下的、被解决过的
 * 问题）；折叠、行的身份与加减账目是这个产品自己的规则，全仓只有这一份。不认 React 与 DOM。
 */
export {
  basename,
  computeFile,
  type DiffFile,
  type DiffPiece,
  type DiffRow,
  type DiffRowKind,
  type DiffStat,
  diffStatOf,
  type PieceColor,
  parseUnifiedPatch,
  toDisplayPath,
  wholeFile,
} from './unified-diff'
