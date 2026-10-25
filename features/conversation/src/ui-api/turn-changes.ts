import { defineContributionPoint, useContributions } from '@poietica/ui-kernel'
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react'

/*
 * 一轮回复下面那条「N 个文件已更改 / 撤销」的数据落点。
 *
 * 账本属于 review（它订阅引擎的 turnFileChanged 落账、按工作区回退文件），conversation
 * 只画那一条：两个功能之间只能经 contract / core-api / ui-api 协作，所以形状与投递口
 * 都住在这一格，review 往这里贡献一台 Provider，conversation 只把贡献套在树上 ——
 * 与 workspaceGitProviders 同一形制。
 *
 * 形状按**轮**寻址：一条对话有多轮，每轮各自一份账。行数是**原始**增删 —— 撤销之后不清零，
 * 只把 reverted 翻成 true，否则「撤销过的那一轮到底改了多少」这件事就没人记得了。
 */

/** 这一轮改过的一个文件。path 是相对工作区根、正斜杠的形式，界面直接显示。 */
export interface TurnChangesFile {
  readonly path: string
  readonly added: number
  readonly removed: number
}

/** 这一轮的文件账。reverted 之后行数仍是原值 —— 撤销说的是「回退了没有」，不是「没改过」。 */
export interface TurnChangesView {
  readonly turn: number
  /** 文件数由提供方数好：同一份账在别处也要报这个数，不给人二次计数的机会。 */
  readonly fileCount: number
  readonly added: number
  readonly removed: number
  readonly reverted: boolean
  readonly files: readonly TurnChangesFile[]
}

/**
 * 一条对话的文件账，以及「把这一轮退回去」。
 *
 * `rewind` 交回的 promise 在**整件事办完**（人确认过、文件写完、账本标过）才落地：调用方
 * 拿它当「这一次操作还在路上」的判据，不必自己猜什么时候可以再点一次。
 */
export interface TurnChangesApi {
  /**
   * 纯读取。数据没变时必须交回**同一个**引用 —— 它喂给 useSyncExternalStore 的 getSnapshot，
   * 每次新造一个数组会让订阅者一路重渲染。
   */
  changesOf(threadId: string): readonly TurnChangesView[]
  subscribe(threadId: string, listener: () => void): () => void
  /** 这一轮没有可撤销的账（空轮、已经撤销过）或写回失败时抛出；失败由调用方报到横幅上。 */
  rewind(threadId: string, turn: number): Promise<void>
  /**
   * 这一轮某文件改前改后的正文。
   *
   * 只有账本主人（review）手里有这两半：写完之后磁盘上只剩 after，事后去读拿不回 before。
   * 点文件行开右坞 diff 时先取它，再交给 turnDiffOpeners 里那个落点。
   */
  patch(threadId: string, turn: number, path: string): Promise<{ before: string | null; after: string | null }>
}

/**
 * 「把这一轮这个文件的改动开到右坞」这件事本身的投递口。
 *
 * conversation 只发出这个意图（点的是它画的那一行），落点归 files —— 右坞的文件面板是它的格。
 * 与 composerProviders 同一形制：这里留贡献点，谁认识坞谁来接手；一个都没有时文件行画成
 * 不可点（不画一个点了没反应的链接）。
 */
export interface TurnDiffRequest {
  /** 哪条对话（右坞按它分账）。 */
  readonly threadId: string
  readonly turn: number
  /** 相对工作区根、正斜杠 —— 与 TurnChangesFile.path 同一份写法。 */
  readonly path: string
  /** 改前改后的正文：账本里那两半，由 review 取。 */
  readonly before: string | null
  readonly after: string | null
}
export interface TurnDiffOpener {
  readonly id: string
  readonly order: number
  open(request: TurnDiffRequest): void
}
export const turnDiffOpeners = defineContributionPoint<TurnDiffOpener>('conversation.turnDiffOpeners')

/** 此刻接手的那个落点（order 最小的）；一个都没装时为 null —— 文件行据此画成不可点。 */
export function useTurnDiffOpener(): TurnDiffOpener | null {
  const openers = useContributions(turnDiffOpeners)

  return useMemo(
    () => [...openers].sort((left, right) => left.item.order - right.item.order)[0]?.item ?? null,
    [openers],
  )
}

/** 没有提供者时是 null，不是抛错：单测夹具、没装 review 功能的宿主都拿得到「这条 UI 不存在」这个合法答案。 */
export const turnChangesContext = createContext<TurnChangesApi | null>(null)

export function useTurnChanges(): TurnChangesApi | null {
  return useContext(turnChangesContext)
}

/** 引用终生不变：没有提供者时 useSyncExternalStore 需要一个恒定的快照。 */
const NO_CHANGES: readonly TurnChangesView[] = Object.freeze([])

const NOTHING = (): void => undefined

/**
 * 某条对话的文件账，随提供方的通知重取。
 *
 * 订阅与读取都按 `(api, threadId)` 稳定：内联箭头等于每次渲染换一个 getSnapshot，
 * 订阅者会一路重渲染。引用稳定本身由提供方保证（见 changesOf 的约定）。
 */
export function useTurnChangesOf(threadId: string): readonly TurnChangesView[] {
  const api = useTurnChanges()
  const subscribe = useCallback(
    (onChange: () => void) => (api === null ? NOTHING : api.subscribe(threadId, onChange)),
    [api, threadId],
  )
  const read = useCallback(() => (api === null ? NO_CHANGES : api.changesOf(threadId)), [api, threadId])

  return useSyncExternalStore(subscribe, read, read)
}

/** 提供者：谁认账本谁来贡献（现在是 review）。与 composerProviders 同形。 */
export interface TurnChangesProviderItem {
  readonly id: string
  readonly order: number
  readonly component: ComponentType<{ readonly children: ReactNode }>
}
export const turnChangesProviders = defineContributionPoint<TurnChangesProviderItem>(
  'conversation.turnChangesProviders',
)
