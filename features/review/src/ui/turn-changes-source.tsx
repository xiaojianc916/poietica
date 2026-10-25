import { Button, ConfirmationDialog, Dialog } from '@poietica/design-system'
import type { TurnChangesApi, TurnChangesView } from '@poietica/feature-conversation/ui-api'
import { turnChangesContext } from '@poietica/feature-conversation/ui-api'
import type { Logger } from '@poietica/foundation'
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react'

/*
 * 每轮回复下方那条文件改动条的事实源（`conversation.turnChangesProviders` 的提供方）。
 *
 * 账本属于 review：它订阅引擎的 turnFileChanged 落账、按工作区写回文件；conversation 只画。
 * 这一层管三件事：
 *
 *   1. **按对话缓存**那份账。`changesOf` 在渲染期被调用（useSyncExternalStore 的 getSnapshot），
 *      必须纯、且没变时交回同一个引用 —— 真正发起读取的副作用只落在 subscribe 与通知里。
 *   2. 撤销的确认框。**先 preview 再弹框**：「哪些文件被改过、能不能退」是 review core 读了磁盘
 *      才知道的事实，界面不猜；确认之后才 apply。
 *   3. 安全判据说人话。挡路的文件一类一句，确认键禁用 —— 那一轮确实退不了。
 *
 * 失败一律走 `onFailure`（装配处接到横幅上），不让 promise 拒绝：调用方只拿它当「这一次办完了
 * 没有」，一个没人接的拒绝会在控制台留下一条读不懂的错。
 */

/** preview 的结论：哪些文件能回、哪些不能、能不能整体退。 */
export interface TurnRewindPreview {
  readonly safe: readonly { readonly path: string }[]
  readonly unsafe: readonly { readonly path: string; readonly reason: 'externally_modified' | 'missing' }[]
  readonly canApply: boolean
}

/** review 契约的薄封装。方法名只出现在这一层与 api.ts 之间，组件不认识 RPC。 */
export interface TurnChangesGateway {
  list(threadId: string): Promise<readonly TurnChangesView[]>
  preview(threadId: string, turn: number): Promise<TurnRewindPreview>
  /** 有文件在此期间被改过时整体拒绝（不做部分写回），按契约抛 review.rewind_unsafe。 */
  apply(threadId: string, turn: number): Promise<void>
  /** 账变了（落账、撤销完）：参数是受影响的那条对话。 */
  onChanged(listener: (threadId: string) => void): { dispose(): void }
}

/** 引用终生不变：没读到、读到空、读失败都交回它，订阅方拿它做相等判据。 */
const NO_CHANGES: readonly TurnChangesView[] = Object.freeze([])

/**
 * 账本的读取侧：一台按对话分格的缓存。
 *
 * 不自己订阅 Core 的生命周期 —— Core 一重启，进程里那份账就换了主人，由装配处调 `reset()`
 * 整体作废（缓存不能只在首次就绪时加载一次）。
 */
export interface TurnChangesHolder {
  readonly changesOf: (threadId: string) => readonly TurnChangesView[]
  readonly subscribe: (threadId: string, listener: () => void) => () => void
  /**
   * 挂上落账通知，交回退订。归装配处而不是归某一行回复：通知说的是「哪条对话的账动了」，
   * 而这一格的生命周期在整个功能上 —— 挂在行里，人切走那条通知就跟着断了。
   */
  start(): () => void
  /** 就地重读这一条对话（撤销办完之后走这条路，不等通知）。 */
  reload(threadId: string): void
  /** Core 换了一世：作废全部缓存，正被看着的那几条重读一次（断线期间的通知不会补发）。 */
  reset(): void
  stop(): void
}

interface Held {
  rows: readonly TurnChangesView[]
  /** 在飞那一趟的号；0 表示没有。换号即作废上一趟的交回值。 */
  loading: number
}

export function createTurnChangesHolder({
  gateway,
  logger,
}: {
  readonly gateway: TurnChangesGateway
  readonly logger: Logger
}): TurnChangesHolder {
  const held = new Map<string, Held>()
  const listeners = new Map<string, Set<() => void>>()
  let nextToken = 0
  let stopped = false

  const notify = (threadId: string): void => {
    for (const listener of [...(listeners.get(threadId) ?? [])]) {
      listener()
    }
  }

  /* 读一趟。entry 是这一格**当下**的那一份：中途被 reset、或被最后一个看客退订删掉，交回值直接丢掉。 */
  const fetchInto = (threadId: string, entry: Held): void => {
    const token = ++nextToken
    entry.loading = token
    void gateway.list(threadId).then(
      (rows) => {
        if (stopped || held.get(threadId) !== entry || entry.loading !== token) {
          return
        }
        entry.loading = 0
        entry.rows = rows
        notify(threadId)
      },
      (cause: unknown) => {
        if (stopped || held.get(threadId) !== entry || entry.loading !== token) {
          return
        }
        entry.loading = 0
        /* 保留旧值：读不到不该让屏幕上那一条凭空消失。 */
        logger.warn('turn changes unreadable', { error: String(cause), threadId })
      },
    )
  }

  const claim = (threadId: string): Held => {
    const existing = held.get(threadId)
    if (existing !== undefined) {
      return existing
    }
    const fresh: Held = { loading: 0, rows: NO_CHANGES }
    held.set(threadId, fresh)
    return fresh
  }

  const reload = (threadId: string): void => {
    if (stopped) {
      return
    }
    const entry = held.get(threadId)
    if (entry !== undefined) {
      fetchInto(threadId, entry)
    }
  }

  return {
    changesOf: (threadId) => held.get(threadId)?.rows ?? NO_CHANGES,
    subscribe: (threadId, listener) => {
      const set = listeners.get(threadId) ?? new Set<() => void>()
      listeners.set(threadId, set)
      set.add(listener)
      /* 读取落在订阅里、不落在渲染期：渲染期发请求会在 StrictMode 的双渲染里发两次。 */
      fetchInto(threadId, claim(threadId))
      return () => {
        set.delete(listener)
        if (set.size > 0) {
          return
        }
        /* 最后一个看客走了就放手：这张表按对话增长，没有删除路径就是一条泄漏。 */
        listeners.delete(threadId)
        held.delete(threadId)
      }
    },
    start: () => {
      const off = gateway.onChanged(reload)
      return () => {
        off.dispose()
      }
    },
    reload,
    reset() {
      if (stopped) {
        return
      }
      for (const [threadId, entry] of [...held]) {
        /* 换号作废在飞的那一趟，再按当下的看客重读。 */
        entry.loading = 0
        entry.rows = NO_CHANGES
        notify(threadId)
        fetchInto(threadId, entry)
      }
    },
    stop() {
      stopped = true
      listeners.clear()
      held.clear()
    },
  }
}

/** 「这一轮不能退」的原因说人话：两种各说各的，界面不猜。 */
function obstacleLabel(file: TurnRewindPreview['unsafe'][number]): string {
  return file.reason === 'missing' ? '已不存在' : '被改过'
}

/** 确认框里那两句：能退时报数量，不能退时说清是哪一类文件挡住了。 */
export function describeRewind(preview: TurnRewindPreview): string {
  if (preview.canApply) {
    return `把这一轮改过的 ${String(preview.safe.length)} 个文件恢复成改动前的样子。\n对话内容不会回退。`
  }

  const kinds = new Map<string, number>()
  for (const file of preview.unsafe) {
    const kind = obstacleLabel(file)
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  }
  const detail = [...kinds].map(([kind, count]) => `${String(count)} 个${kind}`).join('、')
  return `这一轮有 ${detail}，不能撤销。\n对话内容不受影响，工作区文件保持原样。`
}

interface Pending {
  readonly threadId: string
  readonly turn: number
  readonly preview: TurnRewindPreview
  readonly applying: boolean
}

export interface TurnChangesSourceProps {
  readonly children: ReactNode
  readonly gateway: TurnChangesGateway
  readonly holder: TurnChangesHolder
  readonly onFailure: (cause: unknown) => void
}

/**
 * 把「按对话读账 + 撤销」这一副能力投到树上。
 *
 * 确认框归这一层而不是某一行回复：撤销是一次**跨对话**的动作（同一刻只可能有一个在问），
 * 挂在行里会随那一行滚出视口而卸载 —— 人点了撤销、滚了一下、框没了。
 */
export function TurnChangesSource({ children, gateway, holder, onFailure }: TurnChangesSourceProps): ReactNode {
  const [pending, setPending] = useState<Pending | null>(null)
  /* 待确认那一问的回执：确认 true、取消 false。 */
  const settle = useRef<((confirmed: boolean) => void) | null>(null)

  const answer = useCallback((confirmed: boolean) => {
    const resolve = settle.current
    settle.current = null
    resolve?.(confirmed)
  }, [])

  const rewind = useCallback(
    async (threadId: string, turn: number): Promise<void> => {
      /* 已经有一问挂着：再来一次只会覆盖回执，让先前那一问永远等下去。 */
      if (settle.current !== null) {
        return
      }

      let preview: TurnRewindPreview
      try {
        preview = await gateway.preview(threadId, turn)
      } catch (cause: unknown) {
        onFailure(cause)
        return
      }

      const confirmed = await new Promise<boolean>((resolve) => {
        settle.current = resolve
        setPending({ applying: false, preview, threadId, turn })
      })

      if (!confirmed) {
        setPending(null)
        return
      }

      setPending((current) => (current === null ? null : { ...current, applying: true }))
      try {
        await gateway.apply(threadId, turn)
      } catch (cause: unknown) {
        onFailure(cause)
      } finally {
        setPending(null)
        /* 办完就重读：成功要翻成「已撤销」，失败也可能是账本已经变了。 */
        holder.reload(threadId)
      }
    },
    [gateway, holder, onFailure],
  )

  const api = useMemo<TurnChangesApi>(
    () => ({ changesOf: holder.changesOf, rewind, subscribe: holder.subscribe }),
    [holder, rewind],
  )

  return (
    <turnChangesContext.Provider value={api}>
      {children}
      <RewindDialog onAnswer={answer} pending={pending} />
    </turnChangesContext.Provider>
  )
}

/**
 * 撤销那一问。
 *
 * 能退时是确认框（取消 / 撤销）；不能退时是同一张卡、**确认键禁用**加一句为什么 —— 那个问题
 * 此刻没有「确认」可言，而人需要知道的是「哪些文件被改过」，不是再点一次。
 */
function RewindDialog({
  pending,
  onAnswer,
}: {
  readonly pending: Pending | null
  readonly onAnswer: (confirmed: boolean) => void
}): ReactNode {
  if (pending === null) {
    return null
  }

  const description = describeRewind(pending.preview)

  if (pending.preview.canApply) {
    return (
      <ConfirmationDialog
        busy={pending.applying}
        confirmLabel="撤销"
        description={description}
        onCancel={() => {
          onAnswer(false)
        }}
        onConfirm={() => {
          onAnswer(true)
        }}
        open
        title="撤销本轮文件改动"
      />
    )
  }

  return (
    <Dialog
      description={description}
      footer={
        <>
          <Button
            onClick={() => {
              onAnswer(false)
            }}
            type="button"
            variant="secondary"
          >
            取消
          </Button>
          <Button disabled type="button">
            撤销
          </Button>
        </>
      }
      onOpenChange={(next) => {
        if (!next) {
          onAnswer(false)
        }
      }}
      open
      title="撤销本轮文件改动"
    />
  )
}
