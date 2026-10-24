import { Button, cn } from '@poietica/design-system'
import { Check, ChevronRight, GitMergeConflict, LoaderCircle, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { GithubCheck, GithubCheckState, GithubPullRequest, GithubReviewState } from '../contract'
import {
  mergeStatusLabel,
  mergeStatusTone,
  pullStatePresentation,
  relativeTime,
  STATE_GLYPHS,
  sortChecks,
  type Tone,
} from './pr-format'
import type { PrComments } from './pr-store'

import './pr-info.css'

/*
 * 右栏四节：合并状态 / 评论 / 评审 / 检查项。它们和中间正文同源，但回答的是另一类问题 ——
 * 「这条 PR 现在能不能合」。四节都是只读的事实陈述，唯一的写入口是 Reviews 标题行右端那枚 Request 胶囊。
 *
 * 这里**不画卡片**：节与节之间靠留白分开（见 pr-info.css）。底是页面地色 #181818，卡片框在深色下
 * 会变成四条亮边，比内容本身还抢眼。
 *
 * 事实只从 props 进来：这里不读 store、不调 RPC，因此可以单独喂一份数据渲染。
 */

/** 评论条目：kind='review' 的那几条没有正文，只有一条评审结论。 */
type PullComment = PrComments['items'][number]

/** 最多摊开几条检查：与 synara 同数，再多就把右栏顶下去。 */
const CHECKS_VISIBLE_LIMIT = 6

/** 评论在这一节里只报前几条：再多归中栏的时间线。 */
const COMMENTS_SHOWN = 3

/* 与 pr-format 同一套语义 token：绿对勾、红叉、琥珀转圈、灰的虚线空圈。 */
const TONE_TEXT: Readonly<Record<Tone, string>> = {
  ok: 'text-success',
  bad: 'text-destructive',
  warn: 'text-warning',
  muted: 'text-muted-foreground',
}

const REVIEW_LABEL: Readonly<Record<GithubReviewState, string>> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  review_required: 'Review required',
  none: 'No reviews',
}

function checkWord(state: GithubCheckState): string {
  switch (state) {
    case 'success':
      return 'passed'
    case 'failure':
      return 'failed'
    case 'pending':
      return 'running'
    case 'skipped':
      return 'skipped'
    default:
      return 'neutral'
  }
}

/*
 * 一节信息：标题一行（次要墨色、正常字重），下面内容是次要文字色。与 synara 的 InfoSection
 * 同构 —— 右栏不画卡片，四节之间靠 gap-7 的留白分开（用户要的就是这个观感）。
 */
function Card({
  label,
  action,
  children,
}: {
  readonly label: string
  /** 标题行右端的东西（Reviews 的 Request 胶囊）。 */
  readonly action?: ReactNode
  readonly children: ReactNode
}): ReactNode {
  return (
    <section aria-label={label} className="pr-info__section">
      <div className="pr-info__head">
        <h2 className="pr-info__label">{label}</h2>
        {action}
      </div>
      <div className="pr-info__body">{children}</div>
    </section>
  )
}

/** 评论正文在卡上只是一条摘要：换行与缩进压成一行，markdown 记号原样留着（这里不解析 markdown）。 */
function plainLine(body: string): string {
  return body.replace(/\s+/g, ' ').trim()
}

/*
 * 合并状态：一个着色的字形 + 一句话。字形分三路，与 synara 的 MergeStatusSection 一致 ——
 * 能合是绿的对勾（实心），有冲突是红的合并冲突字形，其余（被拦、落后、草稿、未知）用状态字形。
 * 用户说「花花绿绿的 UI 太简陋」，指的就是原来那颗 8px 的圆点：它既没有形状也没有语义。
 */
function MergeStatus({ pull }: { readonly pull: GithubPullRequest }): ReactNode {
  const tone = mergeStatusTone(pull.mergeStatus)
  return (
    <Card label="Merge status">
      <p className="flex items-center gap-2">
        {pull.mergeStatus === 'conflicting' ? (
          <GitMergeConflict aria-hidden className={cn(' ', TONE_TEXT.bad)} />
        ) : tone === 'ok' ? (
          <span className={cn('grid place-items-center rounded-full bg-success text-success-foreground')}>
            <Check aria-hidden />
          </span>
        ) : (
          <StateGlyph pull={pull} />
        )}
        <span className="min-w-0">{mergeStatusLabel(pull.mergeStatus)}</span>
      </p>
      {pull.mergeStatus === 'conflicting' ? (
        <p className="text-muted-foreground">Resolve the conflicts with {pull.baseBranch} before this can merge.</p>
      ) : null}
    </Card>
  )
}

/* 没有合并结论可报时（被拦 / 落后 / 草稿 / 未知），退回这条 PR 自身的状态字形。 */
function StateGlyph({ pull }: { readonly pull: GithubPullRequest }): ReactNode {
  const presentation = pullStatePresentation(pull)
  const Icon = STATE_GLYPHS[presentation.glyph]
  return <Icon aria-hidden className={cn(' ', presentation.className)} />
}

function CommentRow({ comment }: { readonly comment: PullComment }): ReactNode {
  const text = plainLine(comment.body)
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate font-medium">{comment.author}</span>
        <span className=" opacity-70">{relativeTime(comment.createdAt)}</span>
      </span>
      {text === '' ? null : <p className="line-clamp-2 text-xs opacity-80">{text}</p>}
    </li>
  )
}

function CommentsSection({ comments }: { readonly comments: PrComments }): ReactNode {
  const total = comments.items.length
  return (
    <Card label="Comments">
      {total === 0 ? (
        <p className="text-muted-foreground">No comments</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2.5">
          {comments.items.slice(0, COMMENTS_SHOWN).map((comment) => (
            <CommentRow comment={comment} key={comment.id} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function ReviewsSection({
  pull,
  busy,
  onRequestReview,
}: {
  readonly pull: GithubPullRequest
  readonly busy: boolean
  readonly onRequestReview: () => void
}): ReactNode {
  const none = pull.reviewState === 'none'
  /*
   * Request 是标题行右端的一枚胶囊（synara 也是这个位置）。它只是「去 GitHub 上请人评审」——
   * 这里没有挑评审人的能力，所以它跳出去，不假装能在本地发起。
   */
  const request =
    pull.state === 'open' ? (
      <Button
        className="h-6 gap-0.5 rounded-full pr-1.5 pl-2.5 font-normal"
        disabled={busy}
        onClick={onRequestReview}
        size="xs"
        type="button"
        variant="secondary"
      >
        {busy ? 'Requesting…' : 'Request'}
        <ChevronRight aria-hidden />
      </Button>
    ) : null
  return (
    <Card action={request} label="Reviews">
      <p className={cn(none && 'text-muted-foreground')}>{REVIEW_LABEL[pull.reviewState]}</p>
    </Card>
  )
}

/*
 * 单个检查项的字形，照 synara 的 PullRequestCheckStatusIcon：
 * 成功是绿底反白对勾、失败是红底反白叉、在跑是琥珀色转圈、其余是灰色的虚线空圈 —— 四种都占同一个
 * 光学方框（16px），所以名字那一列永远对齐。
 *
 * 为什么不用 lucide 的 `fill-current`：那会把整块圆面连同笔画一起涂满，叉与勾反而消失（成了实心圆点）。
 * synara 的实心对勾来自另一套字形族（Central 的 variant="fill"），lucide 没有对应物 ——
 * 所以这里自己拼：一个着色实心圆 + 里面一枚反色的小字形，效果与它一致。
 */
function CheckGlyph({ state }: { readonly state: GithubCheckState }): ReactNode {
  const shell = 'grid   place-items-center rounded-full'
  if (state === 'pending') {
    return <LoaderCircle aria-hidden className=" animate-spin text-warning" />
  }
  if (state === 'success') {
    return (
      <span className={cn(shell, 'bg-success text-success-foreground')}>
        <Check aria-hidden />
      </span>
    )
  }
  if (state === 'failure') {
    return (
      <span className={cn(shell, 'bg-destructive text-destructive-foreground')}>
        <X aria-hidden />
      </span>
    )
  }
  return (
    <span className={cn(shell)}>
      <span aria-hidden className=" rounded-full border border-dashed opacity-50" />
    </span>
  )
}

/* 一行检查项：字形在左、名字在右；有链接时整行可点，悬停抬底色。 */
function CheckRow({ check }: { readonly check: GithubCheck }): ReactNode {
  return (
    <li className="pr-info__check">
      <CheckGlyph state={check.state} />
      <span className="min-w-0 truncate" title={check.name}>
        {check.name}
      </span>
      {/* 状态词不进视觉，但读屏要能读出来（只看颜色分不出红绿的人是靠这个）。 */}
      <span className="sr-only">{checkWord(check.state)}</span>
    </li>
  )
}

function ChecksCard({ checks }: { readonly checks: readonly GithubCheck[] }): ReactNode {
  const [showAll, setShowAll] = useState(false)
  /* 失败的排前面：这一节先回答「哪儿红了」。键里带序号是因为同名检查确实会重复出现。 */
  const ordered = sortChecks(checks)
  const visible = showAll ? ordered : ordered.slice(0, CHECKS_VISIBLE_LIMIT)
  return (
    <Card label="Checks">
      {checks.length === 0 ? (
        <p className="text-muted-foreground">No checks reported</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-1">
          {visible.map((check, index) => (
            <CheckRow check={check} key={`${check.name}#${String(index)}`} />
          ))}
        </ul>
      )}
      {ordered.length > CHECKS_VISIBLE_LIMIT ? (
        <button
          className="pr-info__more"
          onClick={() => {
            setShowAll((current) => !current)
          }}
          type="button"
        >
          {showAll ? 'Show fewer' : 'View more'}
        </button>
      ) : null}
    </Card>
  )
}

/** 详情在路上时的占位：四张卡的位置留住，读完不会跳一下。 */
function InfoSkeleton(): ReactNode {
  return (
    <div aria-busy="true" className="pr-info">
      {[0, 1, 2, 3].map((card) => (
        <div className="pr-info__section" key={card}>
          <div className="pr-info__skeleton-line w-20" />
          <div className="pr-info__skeleton-line w-full" />
          <div className="pr-info__skeleton-line w-2/3" />
        </div>
      ))}
    </div>
  )
}

export function PrInfo({
  pull,
  comments,
  onRequestReview,
  busy,
}: {
  readonly pull: GithubPullRequest | null
  readonly comments: PrComments
  readonly onRequestReview: () => void
  readonly busy: boolean
}): ReactNode {
  /*
   * 这一块拿不到 facts.phase，只能从两样东西推出该画什么：pull 在不在手上、评论那一份读没读完。
   * 三种情形要分开：还在读（骨架）、读完了但没选任何一条（请选一条，不是错误）、
   * 选了但读不到（这一条已经不在 GitHub 上了）。
   */
  const loading = pull === null && comments.phase === 'loading'
  const idle = pull === null && !loading && comments.phase === 'idle'
  return (
    <aside aria-label="Details" className="pr-info">
      {loading ? <InfoSkeleton /> : null}
      {idle ? <p className="pr-info__empty">Select a pull request to see its merge status.</p> : null}
      {pull === null && !loading && !idle ? <p className="pr-info__empty">Pull request unavailable</p> : null}
      {pull === null ? null : (
        <>
          <MergeStatus pull={pull} />
          <CommentsSection comments={comments} />
          <ReviewsSection busy={busy} onRequestReview={onRequestReview} pull={pull} />
          <ChecksCard checks={pull.checks} />
        </>
      )}
    </aside>
  )
}
