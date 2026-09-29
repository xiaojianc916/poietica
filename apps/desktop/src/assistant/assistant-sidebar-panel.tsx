import { isProjectlessWorkspaceRoot } from '@poietica/conversation'
import { AssistantThreadList } from '@poietica/conversation/surface'
import { Banner, useCopy } from '@poietica/design-system'
import { openBrowserUrlExternally } from '@poietica/native-bridge/browser'
import { memo, useCallback, useMemo, useState } from 'react'
import { useWorkspaceRoots } from '../workspace/roots-context'
import { useCollapsedWorkspaces, useThreadsActions, useThreadsList } from './threads-context'

export interface AssistantSidebarPanelProps {
  readonly activeThreadId: string | null
  readonly onCreate: () => void
  readonly onOpen: (threadId: string, title: string) => void
  /** 跳去设置里的「已归档」。归档横幅上那颗按钮的落点。 */
  readonly onShowArchived: () => void
  readonly runningThreadIds: ReadonlySet<string>
}

export const AssistantSidebarPanel = memo(function AssistantSidebarPanel({
  activeThreadId,
  onCreate,
  onOpen,
  onShowArchived,
  runningThreadIds,
}: AssistantSidebarPanelProps) {
  const threads = useThreadsActions()
  const { failure, groups, isLoading } = useThreadsList()
  const [collapsedWorkspaces, toggleWorkspace] = useCollapsedWorkspaces()
  const { copy } = useCopy()

  /*
   * 分享的结果：store 只记失败（failure 是整张列表共用的一句），成功要交出一段链接 ——
   * 那是一次性的事实，不进 store。编号让同一个动作重来一次时横幅重新计时。
   */
  const [sharing, setSharing] = useState<string | null>(null)
  const [shared, setShared] = useState<{
    url: string
    truncated: boolean
    seq: number
  } | null>(null)

  const projectlessWorkspaces = useMemo(
    () =>
      new Set(
        groups.filter((group) => isProjectlessWorkspaceRoot(group.id)).map((group) => group.id),
      ),
    [groups],
  )

  /* 不点名工作区就是「当前那个」，点了名就先切过去 —— 见上面那段。 */
  const { setActive: setActiveWorkspaceRoot } = useWorkspaceRoots()
  const create = useCallback(
    (workspaceId?: string) => {
      if (workspaceId !== undefined) {
        setActiveWorkspaceRoot(workspaceId)
      }

      onCreate()
    },
    [onCreate, setActiveWorkspaceRoot],
  )

  const activate = useCallback(
    (threadId: string) => {
      onOpen(threadId, threads.titleOf(threadId))
    },
    [onOpen, threads],
  )

  const pin = useCallback(
    (threadId: string, pinned: boolean) => {
      void threads.setPinned(threadId, pinned)
    },
    [threads],
  )

  const rename = useCallback(
    (threadId: string, title: string) => {
      void threads.rename(threadId, title)
    },
    [threads],
  )

  const exportThread = useCallback(
    (threadId: string) => {
      void threads.export(threadId)
    },
    [threads],
  )

  /*
   * 上传要一次点击就兑现：链接同时落进剪贴板并在一条横幅里报出来，用户不必先读提示
   * 再手动复制。失败时剪贴板一个字都不写 —— 写进去的是上一次的旧链接。
   */
  const shareThread = useCallback(
    (threadId: string) => {
      setSharing(threadId)
      setShared(null)
      void threads.share(threadId).then((result) => {
        setSharing((busy) => (busy === threadId ? null : busy))
        if (result !== null) {
          copy(result.url)
          setShared((held) => ({
            url: result.url,
            truncated: result.truncated,
            seq: (held?.seq ?? 0) + 1,
          }))
        }
      })
    },
    [copy, threads],
  )

  /*
   * 刚归档的那条对话，以及它的编号。留着是为了给出一句「会话已归档」和一条撤销；
   * 序号让同一个动作重来一次时横幅重新计时（卸载再挂载，见 Banner 的头注）。
   */
  const [archived, setArchived] = useState<{ threadId: string; seq: number } | null>(null)

  const archive = useCallback(
    (threadId: string) => {
      void threads.archive(threadId, true).then(() => {
        setArchived((held) => ({ threadId, seq: (held?.seq ?? 0) + 1 }))
      })
    },
    [threads],
  )

  /* 撤销就是把刚归档的那条放回去，放回去之后这句就不该还在屏上。 */
  const undoArchive = useCallback(() => {
    const threadId = archived?.threadId

    if (threadId === undefined) {
      return
    }

    setArchived(null)
    void threads.archive(threadId, false)
  }, [archived, threads])

  /* 去看看已归档：横幅先撤，再打开设置那一页 —— 不然它会在设置上面又飘四秒。 */
  const showArchived = useCallback(() => {
    setArchived(null)
    onShowArchived()
  }, [onShowArchived])

  /* 打开刚分享的链接：横幅先撤，再交给系统浏览器；打不开只记诊断，链接仍已复制。 */
  const openShared = useCallback(() => {
    const url = shared?.url

    if (url === undefined) {
      return
    }

    setShared(null)
    void openBrowserUrlExternally(url).catch((cause: unknown) => {
      console.error('[Poietica] Failed to open the shared link', cause)
    })
  }, [shared])

  return (
    <div className="assistant-panel">
      <AssistantThreadList
        activeThreadId={activeThreadId}
        collapsedWorkspaces={collapsedWorkspaces}
        failure={failure}
        groups={groups}
        isLoading={isLoading}
        onActivate={activate}
        onArchive={archive}
        onCreate={create}
        onExport={exportThread}
        onPin={pin}
        onRename={rename}
        onShare={shareThread}
        onToggleWorkspace={toggleWorkspace}
        projectlessWorkspaces={projectlessWorkspaces}
        runningThreadIds={runningThreadIds}
        share={sharing}
      />

      {archived === null ? null : (
        <Banner
          actions={[
            { label: '撤销', onClick: undoArchive },
            { label: '筛选已归档会话', onClick: showArchived, prefix: '或' },
          ]}
          key={`archived-${String(archived.seq)}`}
          onDone={() => {
            setArchived(null)
          }}
          text="会话已归档，可"
          tone="success"
        />
      )}

      {shared === null ? null : (
        <Banner
          actions={[{ label: '打开链接', onClick: openShared }]}
          key={`shared-${String(shared.seq)}`}
          onDone={() => {
            setShared(null)
          }}
          text={
            shared.truncated
              ? '已上传到 my.omp.sh（内容超出上限，已截短），链接已复制，可'
              : '已上传到 my.omp.sh，链接已复制，可'
          }
          tone="success"
        />
      )}
    </div>
  )
})
