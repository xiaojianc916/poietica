import { groupByWorkspace, type ThreadsStore } from '@poietica/agent'
import { ArchiveRestore, FolderClosed, Search, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
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

/**
 * 已归档聊天管理页。
 *
 * 侧边栏的“归档”只把对话移出活动列表；永久删除只能从这里进行，
 * 避免把高风险动作放在每天频繁使用的对话菜单里。
 */
export function ArchivedChatsSettings({ threads }: ArchivedChatsSettingsProps) {
  const snapshot = useSyncExternalStore(
    threads.subscribe,
    threads.archivedSnapshot,
    threads.archivedSnapshot,
  )

  const groups = useMemo(() => groupByWorkspace(snapshot.items), [snapshot.items])

  const [query, setQuery] = useState('')
  const [workspaceId, setWorkspaceId] = useState('all')
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null)
  const [deletingAll, setDeletingAll] = useState(false)

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

  const deleteForever = useCallback(
    async (threadId: string, title: string) => {
      if (busyThreadId !== null) {
        return
      }

      const confirmed = window.confirm(`永久删除“${title}”？此操作无法撤销。`)

      if (!confirmed) {
        return
      }

      setBusyThreadId(threadId)

      try {
        await threads.remove(threadId)
      } finally {
        setBusyThreadId(null)
      }
    },
    [busyThreadId, threads],
  )

  const deleteAll = useCallback(async () => {
    if (deletingAll || snapshot.items.length === 0) {
      return
    }

    const confirmed = window.confirm(
      `永久删除全部 ${snapshot.items.length} 个已归档聊天？此操作无法撤销。`,
    )

    if (!confirmed) {
      return
    }

    setDeletingAll(true)

    try {
      for (const item of snapshot.items) {
        await threads.remove(item.id)
      }
    } finally {
      setDeletingAll(false)
    }
  }, [deletingAll, snapshot.items, threads])

  return (
    <section className="archived-chats">
      <div className="archived-chats__heading">
        <p>归档不会删除聊天内容，可以随时恢复。</p>

        <button
          className="archived-chats__delete-all"
          disabled={deletingAll || snapshot.items.length === 0}
          onClick={() => {
            void deleteAll()
          }}
          type="button"
        >
          {deletingAll ? '正在删除…' : '全部删除'}
        </button>
      </div>

      <div className="archived-chats__toolbar">
        <label className="archived-chats__search">
          <Search aria-hidden="true" />

          <input
            onChange={(event) => {
              setQuery(event.target.value)
            }}
            placeholder="搜索已归档聊天"
            type="search"
            value={query}
          />
        </label>

        <label className="archived-chats__filter">
          <FolderClosed aria-hidden="true" />

          <select
            aria-label="筛选项目"
            onChange={(event) => {
              setWorkspaceId(event.target.value)
            }}
            value={workspaceId}
          >
            <option value="all">所有项目</option>

            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name ?? '默认项目'}
              </option>
            ))}
          </select>
        </label>
      </div>

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
          <section className="archived-chats__group" key={group.id}>
            <header className="archived-chats__group-header">
              <FolderClosed aria-hidden="true" />

              <strong>{group.name ?? '默认项目'}</strong>

              <span>{group.items.length} 个聊天</span>
            </header>

            <div className="archived-chats__list">
              {group.items.map((item) => {
                const busy = busyThreadId === item.id || deletingAll

                return (
                  <article className="archived-chats__row" key={item.id}>
                    <div className="archived-chats__row-copy">
                      <strong>{item.title}</strong>

                      <time dateTime={item.updatedAt}>
                        {ARCHIVED_DATE.format(new Date(item.updatedAt))}
                      </time>
                    </div>

                    <div className="archived-chats__actions">
                      <button
                        aria-label={`永久删除 ${item.title}`}
                        className="archived-chats__delete"
                        disabled={busy}
                        onClick={() => {
                          void deleteForever(item.id, item.title)
                        }}
                        title="永久删除"
                        type="button"
                      >
                        <Trash2 aria-hidden="true" />
                      </button>

                      <button
                        className="archived-chats__restore"
                        disabled={busy}
                        onClick={() => {
                          void restore(item.id)
                        }}
                        type="button"
                      >
                        <ArchiveRestore aria-hidden="true" />
                        <span>{busyThreadId === item.id ? '处理中…' : '取消归档'}</span>
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}
