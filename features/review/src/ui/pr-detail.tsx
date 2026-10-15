import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@poietica/design-system'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ExternalLink,
  GitMerge,
  GitMergeConflict,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link as LinkIcon,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { GithubComment, GithubMergeMethod, GithubPullRequest, GithubReviewState } from '../contract'
import { Avatar } from './avatar'
import { pullBranchLine, pullStatePresentation, relativeTime, relativeTimeAgo, type StateGlyph } from './pr-format'
import type { PrComments, PrFacts, PrState, PrTab } from './pr-store'

import './pr-detail.css'

/*
 * 中栏：一条 pull request 的详情。三个标签（Summary / Changes / Timeline）、右上四个动作、
 * 正文（Markdown）、以及底部的评论流与输入框。
 *
 * 纯展示：markdown 由页面注入（能画 markdown 的 Prose 属于 conversation，功能之间不得互相
 * import ui），本文件不引 markdown 库、不调 RPC。
 */

export interface PrDetailProps {
  readonly state: PrState
  readonly pull: GithubPullRequest | null
  readonly progress: PrFacts['phase']
  readonly comments: PrComments
  readonly onTab: (tab: PrTab) => void
  readonly onDraft: (value: string) => void
  readonly onComment: () => void
  /** 草稿 / 可评审的切换（状态胶囊那两项）。 */
  readonly onSetDraftState: (draft: boolean) => void
  readonly busy: boolean
  /** 仓库短名，详情头的「repo #n」用。 */
  readonly repositoryName: string | null
  /** 页面注入的 Markdown 渲染器。 */
  readonly markdown: (text: string) => ReactNode
}

/** 顶部那一条工具条要吃的东西。它由页面渲染（见 pr-page.tsx），所以单独一份 props。 */
export interface PrDetailBarProps {
  readonly state: PrState
  readonly pull: GithubPullRequest | null
  readonly busy: boolean
  readonly onTab: (tab: PrTab) => void
  readonly onCopyLink: () => void
  readonly onOpenExternal: () => void
  readonly onSendToAgent: () => void
  readonly onMerge: (method: GithubMergeMethod) => void
}

const TAB_LABEL: Readonly<Record<PrTab, string>> = {
  summary: 'Summary',
  changes: 'Changes',
  timeline: 'Timeline',
}

/* 状态字形表：与左栏、右栏读同一套（见 pr-format）。 */
const STATE_GLYPHS: Readonly<Record<StateGlyph, typeof GitMerge>> = {
  'pr-open': GitPullRequest,
  'pr-draft': GitPullRequestDraft,
  'pr-merged': GitMerge,
  'pr-closed': GitPullRequestClosed,
  'pr-conflict': GitMergeConflict,
}

const ROW_CLASS = 'min-w-0 flex-1 truncate'

const REVIEW_WORD: Readonly<Record<GithubReviewState, string>> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  review_required: 'Review required',
  none: '',
}

/** 还没有 pull 在手时的三种情形：还没选、正在读、读不到。文案按情形分开，不混成一句错误。 */
const NOTHING: Readonly<
  Record<'idle' | 'missing' | 'unreadable', { readonly title: string; readonly detail: string }>
> = {
  idle: { title: 'Select a pull request', detail: 'Pick one from the list to review it here.' },
  missing: {
    title: 'This pull request is no longer available.',
    detail: 'It may have been closed and deleted, or the number no longer exists in this repository.',
  },
  unreadable: {
    title: 'This pull request could not be read.',
    detail: 'Check that gh can still read this repository, then try again.',
  },
}

function bodyOf(p: PrDetailProps): ReactNode {
  const { pull, progress } = p
  if (pull !== null) {
    return (
      <Body
        comments={p.comments}
        markdown={p.markdown}
        onSetDraftState={p.onSetDraftState}
        pull={pull}
        repositoryName={p.repositoryName}
        state={p.state}
      />
    )
  }
  if (progress === 'loading') {
    return <DetailSkeleton />
  }
  const held = NOTHING[progress === 'idle' ? 'idle' : progress === 'missing' ? 'missing' : 'unreadable']
  return <Blank detail={held.detail} title={held.title} />
}

export function PrDetail(p: PrDetailProps): ReactNode {
  const { pull } = p
  return (
    <div className="pr-detail flex h-full min-h-0 flex-col">
      {/* 标签行在中栏正文上方；四个动作在页面顶层那条工具条上。 */}
      <PrDetailTabs onTab={p.onTab} pull={pull} tab={p.state.tab} />
      <div className="pr-detail__scroll">{bodyOf(p)}</div>
      {pull === null ? null : (
        <Composer busy={p.busy} draft={p.state.draft} onComment={p.onComment} onDraft={p.onDraft} tab={p.state.tab} />
      )}
    </div>
  )
}

/* 标签行在左、动作在右；动作里 Merge 是唯一带下拉的。 */
/*
 * 标签行：Summary / Changes / Timeline。它留在**中栏正文的上方**（它原本的位置）。
 *
 * 四个动作**不在这里** —— 它们在页面顶层那条满宽工具条上（见 PrDetailActions），
 * 因此停在窗口最右、也就是右栏那些节的上方。这两件事本来被放在同一行里，是错的：
 * 标签属于中栏，动作属于页面。
 */
export function PrDetailTabs({
  pull,
  tab,
  onTab,
}: {
  readonly pull: GithubPullRequest | null
  readonly tab: PrTab
  readonly onTab: (tab: PrTab) => void
}): ReactNode {
  return (
    <div className="pr-detail__tabs">
      <div aria-label="Pull request tabs" className="flex min-w-0 shrink-0 items-center gap-0.5" role="tablist">
        {(['summary', 'changes', 'timeline'] as const).map((entry) => (
          <button
            aria-selected={tab === entry}
            className={cn(
              'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors',
              tab === entry ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60',
            )}
            key={entry}
            onClick={() => {
              onTab(entry)
            }}
            role="tab"
            type="button"
          >
            <span>{TAB_LABEL[entry]}</span>
            {entry === 'changes' && pull !== null ? (
              <span className="flex items-center gap-1.5 tabular-nums">
                <span className="text-success">+{pull.additions}</span>
                <span className="text-destructive">−{pull.deletions}</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

/*
 * 页面顶层那条满宽工具条上的四个动作：复制链接、在浏览器打开、Send to agent、Merge。
 * 一行不折行（Merge 曾被挤到第二行），整体推到最右 —— 用户要求它们停在右栏那些节的上方。
 */
export function PrDetailActions({
  pull,
  busy,
  onMerge,
  onCopyLink,
  onOpenExternal,
  onSendToAgent,
}: {
  readonly pull: GithubPullRequest | null
  readonly busy: boolean
  readonly onMerge: (method: GithubMergeMethod) => void
  readonly onCopyLink: () => void
  readonly onOpenExternal: () => void
  readonly onSendToAgent: () => void
}): ReactNode {
  const blocked = pull !== null && pull.mergeStatus !== 'clean'
  return (
    <>
      <CopyLinkButton onCopyLink={onCopyLink} />
      <IconAction label="Open on GitHub" onClick={onOpenExternal}>
        <ExternalLink aria-hidden className="size-4" />
      </IconAction>
      <Button onClick={onSendToAgent} size="sm" type="button" variant="outline">
        Send to agent
      </Button>
      <MergeButton blocked={blocked} busy={busy} onMerge={onMerge} pull={pull} />
    </>
  )
}

/* 复制成功后短暂变对勾：给一次「按到了」的回执，两秒后自己收回。 */
function CopyLinkButton({ onCopyLink }: { readonly onCopyLink: () => void }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <IconAction
      label={copied ? 'Link copied' : 'Copy link'}
      onClick={() => {
        onCopyLink()
        setCopied(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          setCopied(false)
        }, 2000)
      }}
    >
      {copied ? <Check aria-hidden className="size-4 text-success" /> : <LinkIcon aria-hidden className="size-4" />}
    </IconAction>
  )
}

function IconAction({
  children,
  label,
  onClick,
}: {
  readonly children: ReactNode
  readonly label: string
  readonly onClick: () => void
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={onClick}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function MergeButton({
  blocked,
  busy,
  pull,
  onMerge,
}: {
  readonly blocked: boolean
  readonly busy: boolean
  readonly pull: GithubPullRequest | null
  readonly onMerge: (method: GithubMergeMethod) => void
}): ReactNode {
  const disabled = pull === null || busy
  /* 冲突时不给「合并」的假入口：菜单照开，但每一项都写明为什么现在按不动。 */
  const why = blocked ? `Resolve the conflicts with ${pull?.baseBranch ?? 'the base branch'} first` : null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Merge pull request"
        className={cn(
          /* flex-nowrap + whitespace-nowrap：这一格窄一点时「Merge ▾」会折断，
             按钮框还在而字形跳到第二行（真机截图里就是这么坏的）。 */
          'ml-1 flex h-[var(--ui-control-height-sm)] shrink-0 flex-nowrap items-center gap-1 whitespace-nowrap rounded-lg border border-current/15 px-2.5 text-xs transition-colors',
          'text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50',
        )}
        disabled={disabled}
        title={why ?? undefined}
      >
        <GitMerge aria-hidden className="size-3.5" />
        <span>{busy ? 'Merging…' : 'Merge'}</span>
        <ChevronDown aria-hidden className="size-2.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {why === null ? null : (
          <>
            <DropdownMenuLabel>{why}</DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          disabled={blocked}
          onClick={() => {
            onMerge('merge')
          }}
        >
          <span className="min-w-0 flex-1 truncate text-xs">Create a merge commit</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={blocked}
          onClick={() => {
            onMerge('squash')
          }}
        >
          <span className="min-w-0 flex-1 truncate text-xs">Squash and merge</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={blocked}
          onClick={() => {
            onMerge('rebase')
          }}
        >
          <span className="min-w-0 flex-1 truncate text-xs">Rebase and merge</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/*
 * 状态胶囊：与列表行、右栏读同一份呈现规则（词 + 色 + 字形），右侧的 chevron 打开
 * 「Draft / Ready for review」两项单选。合并/关闭的 PR 不给切换入口（GitHub 也不给）。
 *
 * 这是参考实现里的 GitHubItemHeader 那枚胶囊；用户要求把它补上。
 */
function StatePill({
  pull,
  onDraft,
}: {
  readonly pull: GithubPullRequest
  readonly onDraft: (draft: boolean) => void
}): ReactNode {
  const presentation = pullStatePresentation(pull)
  const Glyph = STATE_GLYPHS[presentation.glyph]
  const pill = cn(
    'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',
    'bg-[color-mix(in_srgb,currentColor_12%,transparent)]',
    presentation.className,
  )
  const glyph = <Glyph aria-hidden className="size-3.5" />
  /* 只有还开着的 PR 能转草稿 / 转可评审；已合并与已关闭的只报状态。 */
  if (pull.state !== 'open') {
    return (
      <span className={pill} role="img" aria-label={presentation.label}>
        {glyph}
        <span>{presentation.label}</span>
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`State: ${presentation.label}. Change state`}
        className={cn(pill, 'cursor-pointer pr-1.5')}
      >
        {glyph}
        <span>{presentation.label}</span>
        <ChevronDown aria-hidden className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            if (value === 'draft' && !pull.draft) onDraft(true)
            if (value === 'ready' && pull.draft) onDraft(false)
          }}
          value={pull.draft ? 'draft' : 'ready'}
        >
          <DropdownMenuRadioItem value="draft">
            <GitPullRequestDraft aria-hidden />
            <span className={ROW_CLASS}>Draft</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="ready">
            <GitPullRequest aria-hidden />
            <span className={ROW_CLASS}>Ready for review</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* 正文：标题 → meta 行 → 按标签切 Body。整块居中定宽，与右栏拉开距离。 */
function Body({
  comments,
  markdown,
  pull,
  state,
  repositoryName,
  onSetDraftState,
}: {
  readonly comments: PrComments
  readonly markdown: (text: string) => ReactNode
  readonly pull: GithubPullRequest
  readonly state: PrState
  readonly repositoryName: string | null
  /** 状态胶囊那两项的切换回调。 */
  readonly onSetDraftState: (draft: boolean) => void
}): ReactNode {
  return (
    <div className="mx-auto w-full max-w-[52rem] px-6 pb-16">
      <header className="pt-2">
        {/* 状态胶囊 + 「repo #n」：胶囊本身就是草稿/可评审的切换入口（点开是两项单选）。 */}
        <div className="flex min-w-0 items-center gap-2">
          <StatePill onDraft={onSetDraftState} pull={pull} />
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {repositoryName === null ? `#${String(pull.number)}` : `${repositoryName} #${String(pull.number)}`}
          </span>
        </div>
        <h1 className="mt-3 text-[1.75rem] leading-tight font-semibold tracking-tight break-words">{pull.title}</h1>
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Avatar login={pull.author} size="sm" url={pull.avatarUrl} />
          <span className="font-medium text-foreground">{pull.author}</span>
          <span aria-hidden>·</span>
          <span>{relativeTimeAgo(pull.createdAt)}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{pullBranchLine(pull)}</span>
        </p>
      </header>
      {state.tab === 'summary' ? <Summary comments={comments} markdown={markdown} pull={pull} /> : null}
      {state.tab === 'changes' ? <Changes pull={pull} /> : null}
      {state.tab === 'timeline' ? <Timeline comments={comments} markdown={markdown} /> : null}
    </div>
  )
}

function SectionTitle({ children, count }: { readonly children: ReactNode; readonly count?: number }): ReactNode {
  return (
    <h2 className="flex items-center gap-2 text-sm font-medium">
      <span>{children}</span>
      {count === undefined ? null : <span className="tabular-nums text-muted-foreground">{count}</span>}
    </h2>
  )
}

/* 正文之后是这一条的评论流：分隔线 + 「Comments · N」，再下面是卡片或那句 No comments。 */
function Summary({
  comments,
  markdown,
  pull,
}: {
  readonly comments: PrComments
  readonly markdown: (text: string) => ReactNode
  readonly pull: GithubPullRequest
}): ReactNode {
  return (
    <>
      {pull.body.trim() === '' ? (
        <p className="mt-4 text-sm text-muted-foreground">No description provided.</p>
      ) : (
        <div className="pr-detail__prose mt-4">{markdown(pull.body)}</div>
      )}
      <section className="pr-detail__comments mt-8 pt-4">
        <SectionTitle count={comments.items.length}>Comments</SectionTitle>
        {comments.phase === 'loading' ? <p className="mt-3 text-xs text-muted-foreground">Loading comments…</p> : null}
        {comments.phase === 'unreadable' ? (
          <p className="mt-3 text-xs text-muted-foreground">Comments could not be read.</p>
        ) : null}
        {comments.phase === 'ready' && comments.items.length === 0 ? (
          <p className="mt-6 text-center text-xs text-muted-foreground">No comments</p>
        ) : null}
        {comments.items.length === 0 ? null : (
          <div className="mt-3 flex flex-col gap-3">
            {comments.items.map((comment) => (
              <CommentCard comment={comment} key={comment.id} markdown={markdown} />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function Changes({ pull }: { readonly pull: GithubPullRequest }): ReactNode {
  return (
    <div className="mt-4 flex flex-col gap-3">
      <SectionTitle>Changes</SectionTitle>
      <p className="flex items-center gap-1.5 text-sm tabular-nums">
        <span className="text-muted-foreground">{pull.changedFiles} files changed</span>
        <span className="text-success">+{pull.additions}</span>
        <span className="text-destructive">−{pull.deletions}</span>
      </p>
      {/* 不假装能读 diff：这一页只报账，diff 正文在右坞的「审查」面板里读。 */}
      <p className="pr-detail__note">
        The file-by-file diff of this pull request is not shown here yet. Open the request on GitHub to read it.
      </p>
    </div>
  )
}

function Timeline({
  comments,
  markdown,
}: {
  readonly comments: PrComments
  readonly markdown: (text: string) => ReactNode
}): ReactNode {
  return (
    <div className="mt-4 flex flex-col gap-3">
      <SectionTitle>Activity</SectionTitle>
      {comments.phase === 'loading' ? <p className="text-xs text-muted-foreground">Loading activity…</p> : null}
      {comments.phase === 'unreadable' ? (
        <p className="text-xs text-muted-foreground">Activity could not be read.</p>
      ) : null}
      {comments.phase === 'ready' && comments.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No activity yet</p>
      ) : null}
      {comments.items.map((comment) => (
        <CommentCard comment={comment} key={comment.id} markdown={markdown} />
      ))}
    </div>
  )
}

function CommentCard({
  comment,
  markdown,
}: {
  readonly comment: GithubComment
  readonly markdown: (text: string) => ReactNode
}): ReactNode {
  const word = comment.reviewState === null ? '' : REVIEW_WORD[comment.reviewState]
  return (
    <article className="pr-detail__comment flex gap-2.5 rounded-xl p-3">
      <Avatar login={comment.author} size="md" url={comment.avatarUrl} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-1.5 text-xs">
          <span className="font-medium">{comment.author}</span>
          <span className="text-muted-foreground">{relativeTime(comment.createdAt)}</span>
          {word === '' ? null : <span className="text-muted-foreground">· {word}</span>}
        </p>
        {comment.body.trim() === '' ? null : (
          <div className="pr-detail__prose mt-1.5 text-sm">{markdown(comment.body)}</div>
        )}
      </div>
    </article>
  )
}

/* 评论流与输入框同住在正文下方：评论列表在上面，输入条吸在栏底。 */
function Composer({
  busy,
  draft,
  tab,
  onComment,
  onDraft,
}: {
  readonly busy: boolean
  readonly draft: string
  readonly tab: PrTab
  readonly onComment: () => void
  readonly onDraft: (value: string) => void
}): ReactNode {
  const canSend = draft.trim() !== '' && !busy
  const submit = (): void => {
    if (canSend) onComment()
  }
  return (
    <div className="pr-detail__composer shrink-0 px-3 pb-3">
      <div className="mx-auto w-full max-w-[52rem]">
        <div className="pr-detail__input flex items-end gap-2 rounded-xl p-2">
          <textarea
            aria-label="Write a comment"
            className="max-h-40 min-h-[38px] min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-sm outline-none placeholder:text-placeholder"
            onChange={(event) => {
              onDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                submit()
                return
              }
              /* 评论框里的 Escape 交给外层，不要在这里吃掉。 */
              if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
            }}
            placeholder={tab === 'timeline' ? 'Leave a comment' : 'Write a comment…'}
            rows={2}
            value={draft}
          />
          <button
            aria-label="Send comment"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
            disabled={!canSend}
            onClick={submit}
            type="button"
          >
            <ArrowUp aria-hidden className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

function DetailSkeleton(): ReactNode {
  return (
    <div aria-busy="true" className="mx-auto flex w-full max-w-[52rem] flex-col gap-3 px-6 pt-4">
      <div className="pr-detail__skeleton h-7 w-4/5" />
      <div className="pr-detail__skeleton h-4 w-2/5" />
      <div className="pr-detail__skeleton h-28 w-full" />
      <div className="pr-detail__skeleton h-40 w-full" />
    </div>
  )
}

function Blank({ detail, title }: { readonly detail: string; readonly title: string }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs opacity-50">{detail}</p>
    </div>
  )
}
