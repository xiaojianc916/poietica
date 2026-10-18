import {
  GitMerge,
  GitMergeConflict,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react'
import type { GithubCheck, GithubCheckState, GithubMergeStatus, GithubPullRequest, GithubPullState } from '../contract'

/* 代码审查页的纯展示规则：相对时间、状态文案、色调与字形。全在这里，组件里不各写各的。 */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/*
 * 相对时间：与 GitHub 同一档的粗粒度（now / 5m / 3h / 2d / 1w / 1mo / 1y），一律向下取整。
 * 两处用同一份：列表行的 meta 与详情头。传 now 只是为了测试可复现。
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) {
    return ''
  }
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 45) return 'now'
  if (seconds < HOUR) return `${String(Math.floor(seconds / MINUTE))}m`
  if (seconds < DAY) return `${String(Math.floor(seconds / HOUR))}h`
  if (seconds < WEEK) return `${String(Math.floor(seconds / DAY))}d`
  if (seconds < MONTH) return `${String(Math.floor(seconds / WEEK))}w`
  if (seconds < YEAR) return `${String(Math.floor(seconds / MONTH))}mo`
  return `${String(Math.floor(seconds / YEAR))}y`
}

/** 头部与列表都写「1mo ago」这一种；刚好是刚才就写 just now。 */
export function relativeTimeAgo(iso: string, now: number = Date.now()): string {
  const relative = relativeTime(iso, now)
  if (relative === '') return ''
  return relative === 'now' ? 'just now' : `${relative} ago`
}

export type StateGlyph = 'pr-open' | 'pr-draft' | 'pr-merged' | 'pr-closed' | 'pr-conflict'

/** 状态字形：左栏、详情头、右栏读同一份，同一个 PR 在哪一栏都是同一个形状。 */
export const STATE_GLYPHS: Readonly<Record<StateGlyph, LucideIcon>> = {
  'pr-open': GitPullRequest,
  'pr-draft': GitPullRequestDraft,
  'pr-merged': GitMerge,
  'pr-closed': GitPullRequestClosed,
  'pr-conflict': GitMergeConflict,
}

export interface StatePresentation {
  readonly label: string
  /** 胶囊配色（design-system 的语义色 token 类）。 */
  readonly className: string
  readonly glyph: StateGlyph
}

/* 配色只走语义 token（--ui-* 在深浅两套里各有一档），换主题时这几行不用改。 */
const OPEN_TONE = 'text-success'
const MERGED_TONE = 'text-info'
const CLOSED_TONE = 'text-muted-foreground'
const DRAFT_TONE = 'text-muted-foreground'
/* 冲突与「检查失败」同一个红：一整页里「红 = 出事了」只该有一种读法。 */
const CONFLICT_TONE = 'text-destructive'

/*
 * 状态词、配色与字形：列表行、详情头部那枚状态胶囊、以及右栏的兜底字形都读这一份，
 * 所以同一个 PR 在哪一栏都是同一个词、同一个颜色、同一个形状。
 *
 * 优先级照参考实现：草稿 > 冲突 > 开着。草稿不急着合，它的状态就是「草稿」；而一个开着又不是
 * 草稿的 PR 有冲突时，「有冲突」才是人此刻要知道的那件事。
 */
export function pullStatePresentation(
  pr: Pick<GithubPullRequest, 'state' | 'draft' | 'mergeStatus'>,
): StatePresentation {
  if (pr.state === 'merged') {
    return { label: 'Merged', className: MERGED_TONE, glyph: 'pr-merged' }
  }
  if (pr.state === 'closed') {
    return { label: 'Closed', className: CLOSED_TONE, glyph: 'pr-closed' }
  }
  if (pr.draft) {
    return { label: 'Draft', className: DRAFT_TONE, glyph: 'pr-draft' }
  }
  if (pr.mergeStatus === 'conflicting') {
    return { label: 'Has conflicts', className: CONFLICT_TONE, glyph: 'pr-conflict' }
  }
  return { label: 'Open', className: OPEN_TONE, glyph: 'pr-open' }
}

export function mergeStatusLabel(status: GithubMergeStatus): string {
  switch (status) {
    case 'clean':
      return 'Ready to merge'
    case 'conflicting':
      return 'Conflicts with main'
    case 'blocked':
      return 'Blocked by checks or reviews'
    case 'behind':
      return 'Behind the base branch'
    case 'draft':
      return 'Draft pull request'
    default:
      return 'Merge status unknown'
  }
}

export type Tone = 'ok' | 'bad' | 'warn' | 'muted'

export function mergeStatusTone(status: GithubMergeStatus): Tone {
  switch (status) {
    case 'clean':
      return 'ok'
    case 'conflicting':
      return 'bad'
    case 'blocked':
    case 'behind':
      return 'warn'
    default:
      return 'muted'
  }
}

export function checkTone(state: GithubCheckState): Tone {
  switch (state) {
    case 'success':
      return 'ok'
    case 'failure':
      return 'bad'
    case 'pending':
      return 'warn'
    default:
      return 'muted'
  }
}

/*
 * 整份检查的结论：GitHub 只给「最坏的那一格」。没有检查项时按状态说实话 ——
 * 开着的 PR 是「没有检查」而不是「通过」。
 */
export function checksSummaryLabel(checks: readonly GithubCheck[]): string {
  if (checks.length === 0) {
    return 'No checks'
  }
  if (checks.some((check) => check.state === 'failure')) {
    return `${String(checks.filter((check) => check.state === 'failure').length)} failing`
  }
  if (checks.some((check) => check.state === 'pending')) {
    return 'Checks running'
  }
  if (checks.every((check) => check.state === 'neutral' || check.state === 'skipped')) {
    return 'No required checks'
  }
  return 'All checks passed'
}

/** 失败的检查排前面：右栏那张卡片先给人看红的那几条。 */
export function sortChecks(checks: readonly GithubCheck[]): readonly GithubCheck[] {
  const rank: Readonly<Record<GithubCheckState, number>> = {
    failure: 0,
    pending: 1,
    success: 2,
    neutral: 3,
    skipped: 4,
  }
  return [...checks].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
}

/** 列表的 meta 行（含仓库与编号）；列表把编号单独摆，所以它主要用于别处的整行展示。 */
export function pullMetaLine(pr: GithubPullRequest, repositoryName: string | null): string {
  const parts = [pr.author, relativeTimeAgo(pr.createdAt)]
  if (repositoryName !== null) {
    parts.push(`${repositoryName} #${String(pr.number)}`)
  }
  return parts.join(' · ')
}

/** 详情的 meta 行：「xiaojianc916 · 1mo ago · refactor/plugin-ledger-ownership → main」。 */
export function pullBranchLine(pr: GithubPullRequest): string {
  return `${pr.headBranch} → ${pr.baseBranch}`
}

export function pullStateOf(state: GithubPullState): GithubPullState {
  return state
}
