import { groupByWorkspace, type ThreadsStore } from '@poietica/conversation'
import { Button, ConfirmationDialog, Select, type SelectOption } from '@poietica/design-system'
import { ArchiveRestore, Search, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { SettingRow, SettingsGroup, SettingsPage } from './settings-primitives'
import './archived-chats-settings.css'

const ARCHIVED_DATE = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

export interface ArchivedChatsSettingsProps {
  readonly threads: ThreadsStore
}

type PendingDeletion =
  | { readonly kind: 'single'; readonly threadId: string; readonly title: string }
  | { readonly kind: 'all' }

interface DeleteConfirmationCopy {
  readonly confirmLabel: string
  readonly description: string
  readonly title: string
}

function describePendingDeletion(
  pending: PendingDeletion | null,
  archivedCount: number,
): DeleteConfirmationCopy {
  if (pending?.kind === 'all') {
    return {
      confirmLabel: '全部永久删除',
      description: `将永久删除全部 ${archivedCount} 个已归档聊天。此操作无法撤销。`,
      title: '永久删除全部已归档聊天',
    }
  }

  if (pending?.kind === 'single') {
    return {
      confirmLabel: '永久删除',
      description: `将永久删除“${pending.title}”。此操作无法撤销。`,
      title: '永久删除聊天',
    }
  }

  return {
    confirmLabel: '永久删除',
    description: '',
    title: '永久删除聊天',
  }
}

function groupTitle(name: string | null, count: number): string {
  return `${name ?? '默认项目'} · ${count} 个聊天`
}

/**
 * 已归档聊天管理页。
 *
 * 页面结构沿用设置界面的页、组、面板和行，不再为归档列表另建一套卡片语言。
 * 永久删除仍然只从这里进入，避免把高风险动作放进日常会话菜单。
 */
export function ArchivedChatsSettings({ threads }: ArchivedChatsSettingsProps) {
  const snapshot = useSyncExternalStore(
    threads.subscribe,
    threads.archivedSnapshot,
    threads.archivedSnapshot,
  )

  const groups = useMemo(() => groupByWorkspace(snapshot.items), [snapshot.items])

  const workspaceOptions = useMemo<readonly SelectOption[]>(
    () => [
      { value: 'all', label: '所有项目' },
      ...groups.map((group) => ({
        value: group.id,
        label: group.name ?? '默认项目',
      })),
    ],
    [groups],
  )

  const [query, setQuery] = useState('')
  const [workspaceId, setWorkspaceId] = useState('all')
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null)
  const [deletingAll, setDeletingAll] = useState(false)
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null)
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null)

  const normalizedQuery = query.trim().toLocaleLowerCase()

  const visibleGroups = useMemo(
    () =>
      groups
        .filter((group) => workspaceId === 'all' || group.id === workspaceId)
        .map((group) => ({
          ...group,
          items: group.items.filter((item) =>
            item.title.toLocaleLowerCase().includes(normalizedQuery),
          ),
        }))
        .filter((group) => group.items.length > 0),
    [groups, normalizedQuery, workspaceId],
  )

  const restore = useCallback(
    async (threadId: string) => {
      if (busyThreadId !== null) {
        return
      }

      setBusyThreadId(threadId)

      try {
        await threads.archive(threadId, false)
      } finally {
        setBusyThreadId(null)
      }
    },
    [busyThreadId, threads],
  )

  const requestDeleteForever = useCallback(
    (threadId: string, title: string) => {
      if (pendingDeletion !== null || deletingAll || busyThreadId !== null) {
        return
      }

      setDeleteFailure(null)
      setPendingDeletion({ kind: 'single', threadId, title })
    },
    [busyThreadId, deletingAll, pendingDeletion],
  )

  const requestDeleteAll = useCallback(() => {
    if (
      pendingDeletion !== null ||
      deletingAll ||
      busyThreadId !== null ||
      snapshot.items.length === 0
    ) {
      return
    }

    setDeleteFailure(null)
    setPendingDeletion({ kind: 'all' })
  }, [busyThreadId, deletingAll, pendingDeletion, snapshot.items.length])

  const cancelDeletion = useCallback(() => {
    if (busyThreadId !== null || deletingAll) {
      return
    }

    setDeleteFailure(null)
    setPendingDeletion(null)
  }, [busyThreadId, deletingAll])

  const confirmDeletion = useCallback(async () => {
    if (pendingDeletion === null || busyThreadId !== null || deletingAll) {
      return
    }

    setDeleteFailure(null)

    if (pendingDeletion.kind === 'single') {
      setBusyThreadId(pendingDeletion.threadId)

      try {
        await threads.remove(pendingDeletion.threadId)
        setPendingDeletion(null)
      } catch (cause: unknown) {
        console.error('[Poietica] 永久删除聊天失败', cause)
        setDeleteFailure('删除失败，请重试。')
      } finally {
        setBusyThreadId(null)
      }

      return
    }

    setDeletingAll(true)

    try {
      for (const item of snapshot.items) {
        await threads.remove(item.id)
      }

      setPendingDeletion(null)
    } catch (cause: unknown) {
      console.error('[Poietica] 永久删除全部已归档聊天失败', cause)
      setDeleteFailure('删除失败，请重试。')
    } finally {
      setDeletingAll(false)
    }
  }, [busyThreadId, deletingAll, pendingDeletion, snapshot.items, threads])

  const confirmation = describePendingDeletion(pendingDeletion, snapshot.items.length)
  const confirmationDescription =
    deleteFailure === null
      ? confirmation.description
      : `${confirmation.description} ${deleteFailure}`
  const deleteInProgress = deletingAll || busyThreadId !== null

  return (
    <SettingsPage>
      <SettingsGroup title="管理">
        <SettingRow
          description="归档只会将聊天移出活动列表，内容仍然保留并可随时恢复"
          label="保留与恢复"
        >
          <Button
            className="archived-chats__delete-all"
            disabled={
              pendingDeletion !== null ||
              deletingAll ||
              busyThreadId !== null ||
              snapshot.items.length === 0
            }
            onClick={() => {
              requestDeleteAll()
            }}
            size="xs"
            type="button"
            variant="ghost"
          >
            {deletingAll ? '正在删除…' : '全部删除'}
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="筛选">
        <div className="archived-chats__toolbar">
          <label className="archived-chats__search">
            <Search aria-hidden="true" />

            <input
              aria-label="搜索已归档聊天"
              onChange={(event) => {
                setQuery(event.target.value)
              }}
              placeholder="搜索已归档聊天"
              type="search"
              value={query}
            />
          </label>

          <Select
            align="end"
            className="archived-chats__filter"
            data={workspaceOptions}
            onValueChange={(value) => {
              setWorkspaceId(value)
            }}
            type="项目"
            value={workspaceId}
          />
        </div>
      </SettingsGroup>

      {snapshot.failure ? (
        <p className="archived-chats__message archived-chats__message--error" role="alert">
          {snapshot.failure}
        </p>
      ) : null}

      {snapshot.isLoading && snapshot.items.length === 0 ? (
        <p className="archived-chats__message">正在读取已归档聊天…</p>
      ) : null}

      {!snapshot.isLoading && snapshot.items.length === 0 ? (
        <p className="archived-chats__message">还没有已归档的聊天。</p>
      ) : null}

      {snapshot.items.length > 0 && visibleGroups.length === 0 ? (
        <p className="archived-chats__message">没有符合当前筛选条件的聊天。</p>
      ) : null}

      <div className="archived-chats__groups">
        {visibleGroups.map((group) => (
          <SettingsGroup key={group.id} title={groupTitle(group.name, group.items.length)}>
            {group.items.map((item) => {
              const busy = busyThreadId === item.id || pendingDeletion !== null || deletingAll

              return (
                <div className="archived-chats__row" key={item.id}>
                  <div className="archived-chats__row-copy">
                    <strong>{item.title}</strong>

                    <time dateTime={item.updatedAt}>
                      {ARCHIVED_DATE.format(new Date(item.updatedAt))}
                    </time>
                  </div>

                  <div className="archived-chats__actions">
                    <Button
                      aria-label={`永久删除 ${item.title}`}
                      className="archived-chats__delete"
                      disabled={busy}
                      onClick={() => {
                        requestDeleteForever(item.id, item.title)
                      }}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>

                    <Button
                      className="archived-chats__restore"
                      disabled={busy}
                      onClick={() => {
                        void restore(item.id)
                      }}
                      size="xs"
                      type="button"
                      variant="soft"
                    >
                      <ArchiveRestore aria-hidden="true" />

                      <span>{busyThreadId === item.id ? '处理中…' : '取消归档'}</span>
                    </Button>
                  </div>
                </div>
              )
            })}
          </SettingsGroup>
        ))}
      </div>

      <ConfirmationDialog
        busy={deleteInProgress}
        cancelLabel="取消"
        confirmLabel={confirmation.confirmLabel}
        description={confirmationDescription}
        destructive
        onCancel={cancelDeletion}
        onConfirm={() => {
          void confirmDeletion()
        }}
        open={pendingDeletion !== null}
        title={confirmation.title}
      />
    </SettingsPage>
  )
}
