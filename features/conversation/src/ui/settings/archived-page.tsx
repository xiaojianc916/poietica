/// <reference path="../../../../../packages/design-system/src/css.d.ts" />

import {
  Button,
  ConfirmationDialog,
  Select,
  type SelectOption,
  SettingRow,
  SettingsGroup,
  SettingsPage,
} from '@poietica/design-system'
import { type WorkspacesUi, WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { useService } from '@poietica/ui-kernel'
import { ArchiveRestore, Search, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { Thread } from '../../contract'
import type { ConversationApi } from '../api'
import type { ConversationStores } from '../stores'
import { groupByWorkspace, type ThreadListItem } from '../threads/thread-order'
import './archived-page.css'

/*
 * 已归档聊天管理页。**逐字迁移**自 legacy
 * `packages/settings/src/ui/surface/archived-chats-settings.tsx`：
 * 页面结构（页 / 组 / 行）、文案、类名、按钮形状与那两条确认文案一字未改，
 * 两份 CSS（`archived-chats-settings.css` → `archived-page.css`）逐字照抄。
 *
 * 与 legacy 的差别只有数据来路（守则：迁移只换「数据从哪来」）：
 *
 *   legacy                             新架构
 *   threads.subscribe/archivedSnapshot → stores.threads.store（zustand，订阅式选择器）
 *   threads.archive(id,false)          → api.setArchived(id,false) + stores.threads.upsert
 *   threads.remove(id)                 → api.deleteThread(id) + stores.threads.remove
 *   groupByWorkspace(items)            → 同一个函数 + 工作区表查名（线程带的是 id 不是路径）
 *
 * 「已归档」这一格在 07 页的功能设计里没有落点（方案缺口，refactor-log 的 Q22）；
 * 按产品负责人 2026-10-07 的指示补到 conversation 的 ui 里，段内次序照 legacy
 * （快捷键 → 电脑控制 → 用量 → 已归档 → 存储 → 关于）。
 */

const ARCHIVED_DATE = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

type PendingDeletion =
  | { readonly kind: 'single'; readonly threadId: string; readonly title: string }
  | { readonly kind: 'all' }

interface DeleteConfirmationCopy {
  readonly confirmLabel: string
  readonly description: string
  readonly title: string
}

function describePendingDeletion(pending: PendingDeletion | null, archivedCount: number): DeleteConfirmationCopy {
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

  return { confirmLabel: '永久删除', description: '', title: '永久删除聊天' }
}

function groupTitle(name: string | null, count: number): string {
  return `${name ?? '默认项目'} · ${count} 个聊天`
}

/** 归档页读的行形状：Thread 是契约实体，列表项要的是 ISO 串与 isPinned。 */
function toListItem(thread: Thread): ThreadListItem {
  return {
    id: thread.id,
    title: thread.title,
    isPinned: thread.pinned,
    updatedAt: new Date(thread.updatedAt).toISOString(),
    workspaceId: thread.workspaceId,
  }
}

export function ArchivedChatsPage({
  api,
  threads,
}: {
  readonly api: ConversationApi
  readonly threads: ConversationStores['threads']
}): ReactNode {
  const workspaces = useService(WorkspacesUiToken) as WorkspacesUi
  /*
   * 这一页只列已归档的：共享 store 的列表查询带 `includeArchived: false`（侧栏用的就是它），
   * 所以归档页自己按 `includeArchived: true` 拉一份，再筛出 `archived === true`
   * （legacy 的 ThreadsStore 从同一份全量行里切出 active / archived 两格，这里等价）。
   */
  const [archived, setArchived] = useState<{
    readonly items: readonly Thread[]
    readonly isLoading: boolean
    readonly failure: string | null
  }>({ items: [], isLoading: true, failure: null })
  useEffect(() => {
    let cancelled = false

    const load = (): void => {
      void api.listThreads({ includeArchived: true }).then(
        (items) => {
          if (cancelled) return
          setArchived({
            items: items.filter((thread) => thread.archived),
            isLoading: false,
            failure: null,
          })
        },
        (cause: unknown) => {
          if (cancelled) return
          setArchived({
            items: [],
            isLoading: false,
            failure: cause instanceof Error ? cause.message : String(cause),
          })
        },
      )
    }

    load()
    /* 共享 store 的每一次变化（本页归档 / 删除，或别处来的 threads.updated）都重拉一次（legacy 的 archivedSnapshot 同一件事）。 */
    const unsubscribe = threads.store.subscribe(load)

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [api, threads])

  /*
   * 组名从工作区表查 —— 新架构的 thread.workspaceId 是工作区实体 id，不是路径，
   * legacy 的「路径末段」那套在这里会把 uuid 当名字（与侧栏同一判据）。
   */
  const listed = archived.items
  const groups = useMemo(
    () =>
      groupByWorkspace(listed.map(toListItem), (workspaceId) => {
        const workspace = workspaces.store.getState().items.find((w) => w.id === workspaceId)
        return workspace?.name ?? null
      }),
    [listed, workspaces],
  )

  const workspaceOptions = useMemo<readonly SelectOption[]>(
    () => [
      { value: 'all', label: '所有项目' },
      ...groups.map((group) => ({ value: group.id, label: group.name ?? '默认项目' })),
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
          items: group.items.filter((item) => item.title.toLocaleLowerCase().includes(normalizedQuery)),
        }))
        .filter((group) => group.items.length > 0),
    [groups, normalizedQuery, workspaceId],
  )

  const restore = (threadId: string): void => {
    if (busyThreadId !== null) {
      return
    }
    setBusyThreadId(threadId)
    void api.setArchived(threadId, false).then(
      (thread) => {
        threads.upsert(thread)
        setBusyThreadId(null)
      },
      () => {
        setBusyThreadId(null)
      },
    )
  }

  const busy = busyThreadId !== null || deletingAll

  const requestDeleteForever = (threadId: string, title: string): void => {
    if (pendingDeletion !== null || busy) {
      return
    }
    setDeleteFailure(null)
    setPendingDeletion({ kind: 'single', threadId, title })
  }

  const requestDeleteAll = (): void => {
    if (pendingDeletion !== null || busy || listed.length === 0) {
      return
    }
    setDeleteFailure(null)
    setPendingDeletion({ kind: 'all' })
  }

  const cancelDeletion = (): void => {
    if (busy) {
      return
    }
    setDeleteFailure(null)
    setPendingDeletion(null)
  }

  const confirmDeletion = async (): Promise<void> => {
    if (pendingDeletion === null || busy) {
      return
    }
    setDeleteFailure(null)

    if (pendingDeletion.kind === 'single') {
      setBusyThreadId(pendingDeletion.threadId)
      try {
        await api.deleteThread(pendingDeletion.threadId)
        threads.remove(pendingDeletion.threadId)
        setPendingDeletion(null)
      } catch {
        setDeleteFailure('删除失败，请重试。')
      } finally {
        setBusyThreadId(null)
      }
      return
    }

    setDeletingAll(true)
    try {
      for (const item of listed) {
        await api.deleteThread(item.id)
        threads.remove(item.id)
      }
      setPendingDeletion(null)
    } catch {
      setDeleteFailure('删除失败，请重试。')
    } finally {
      setDeletingAll(false)
    }
  }

  const confirmation = describePendingDeletion(pendingDeletion, listed.length)
  const confirmationDescription =
    deleteFailure === null ? confirmation.description : `${confirmation.description} ${deleteFailure}`
  const deleteInProgress = deletingAll || busyThreadId !== null

  return (
    <SettingsPage>
      <SettingsGroup title="管理">
        <SettingRow description="归档只会将聊天移出活动列表，内容仍然保留并可随时恢复" label="保留与恢复">
          <Button
            disabled={pendingDeletion !== null || deleteInProgress || listed.length === 0}
            onClick={requestDeleteAll}
            size="xs"
            type="button"
            variant="dangerSoft"
          >
            <Trash2 aria-hidden="true" />
            {deletingAll ? '正在删除…' : '全部删除'}
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup className="archived-chats__filter-group" title="筛选">
        <div className="archived-chats__toolbar">
          <label className="settings-input settings-input--with-icon">
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
            onValueChange={setWorkspaceId}
            type="项目"
            value={workspaceId}
          />
        </div>
      </SettingsGroup>

      {archived.failure ? (
        <p className="archived-chats__message archived-chats__message--error" role="alert">
          {archived.failure}
        </p>
      ) : null}

      {archived.isLoading && listed.length === 0 ? (
        <p className="archived-chats__message">正在读取已归档聊天…</p>
      ) : null}

      {!archived.isLoading && listed.length === 0 ? (
        <p className="archived-chats__message">还没有已归档的聊天</p>
      ) : null}

      {listed.length > 0 && visibleGroups.length === 0 ? (
        <p className="archived-chats__message">没有符合当前筛选条件的聊天</p>
      ) : null}

      <div className="archived-chats__groups">
        {visibleGroups.map((group) => (
          <SettingsGroup key={group.id} title={groupTitle(group.name, group.items.length)}>
            {group.items.map((item) => {
              const rowBusy = busyThreadId === item.id || pendingDeletion !== null || deletingAll

              return (
                <div className="archived-chats__row" key={item.id}>
                  <div className="archived-chats__row-copy">
                    <strong>{item.title}</strong>

                    <time dateTime={item.updatedAt}>{ARCHIVED_DATE.format(new Date(item.updatedAt))}</time>
                  </div>

                  <div className="archived-chats__actions">
                    <Button
                      aria-label={`永久删除 ${item.title}`}
                      className="archived-chats__delete"
                      disabled={rowBusy}
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
                      disabled={rowBusy}
                      onClick={() => {
                        restore(item.id)
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
