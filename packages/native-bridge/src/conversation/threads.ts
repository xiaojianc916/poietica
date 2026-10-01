import { commands } from '@poietica/contract'
import type { OpenedThread, ThreadPort, ThreadSnapshot } from '@poietica/conversation'
import { throughIpc } from '../ipc-error'
import type { AgentBridgeOptions, PickSavePath } from './launch-contract'
import { controlOf, goalOf } from './selectors'
import { transcriptPageOf } from './transcript-decoding'

export interface AgentThreadBridgeOptions extends AgentBridgeOptions {
  /** 会话导出的落点由宿主给；组合根注入。 */
  readonly pickSavePath: PickSavePath
}

export function createAgentThreadBridge({
  launch,
  cwd,
  pickSavePath,
}: AgentThreadBridgeOptions): ThreadPort {
  const openTarget = async (
    target: { readonly kind: 'create' | 'existing'; readonly threadId: string },
    workspaceRoot?: string | null,
  ): Promise<OpenedThread> => {
    const resolvedLaunch = await launch()
    const opened = await throughIpc(() =>
      commands.agentOpenThread({
        target,
        launch: resolvedLaunch,
        cwd: workspaceRoot ?? cwd?.() ?? null,
      }),
    )

    return {
      thread: opened.thread,
      selectors: opened.selectors.map(controlOf),
      goal: goalOf(opened.goal),
      history: opened.history,
      transcript: transcriptPageOf(opened.transcript.json),
    }
  }

  return {
    list: () => throughIpc(() => commands.agentThreads()),
    read: async (threadId): Promise<ThreadSnapshot> => {
      const snapshot = await throughIpc(() => commands.agentThreadSnapshot({ threadId }))
      return {
        thread: snapshot.thread,
        ...(snapshot.usage === null ? {} : { usage: snapshot.usage }),
      }
    },
    create: (threadId, workspaceRoot) => openTarget({ kind: 'create', threadId }, workspaceRoot),
    open: (threadId) => openTarget({ kind: 'existing', threadId }),
    export: async (threadId) => {
      /*
       * 落点先问宿主：对话框挂在窗口上，只有主进程开得出。用户取消就是 false ——
       * 与「导出失败」分开，前者不是错误。
       */
      const destination = await pickSavePath({
        defaultPath: 'session.zip',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })

      if (destination === null) {
        return false
      }

      const resolved = await launch()

      return throughIpc(() =>
        commands.agentExportThread({ threadId, launch: resolved, destination }),
      )
    },
    /*
     * 分享把对话传出本机，所以这一条**没有** `export` 那样的「用户取消了」中间态：
     * 它要么交回一条链接，要么如实抛错（会话找不到、上传被拒）。脱敏策略在桥那一侧
     * 按 agent 自己的设置办，这一层只转发结果。
     */
    share: async (threadId) =>
      throughIpc(async () => commands.agentShareThread({ threadId, launch: await launch() })),
    rename: async (threadId, title) => {
      await throughIpc(() => commands.agentRenameThread({ threadId, title }))
    },
    fork: async (threadId, title, undoCount) => {
      const resolvedLaunch = await launch()
      return throughIpc(() =>
        commands.agentForkThread({
          threadId,
          title,
          dropTurns: undoCount,
          launch: resolvedLaunch,
          cwd: cwd?.() ?? null,
        }),
      )
    },
    remove: async (threadId) => {
      await throughIpc(() => commands.agentDeleteThread({ threadId }))
    },
    archive: async (threadId, archived) => {
      await throughIpc(() => commands.agentArchiveThread({ threadId, archived }))
    },
    setPinned: async (threadId, pinned) => {
      await throughIpc(() => commands.agentPinThread({ threadId, pinned }))
    },
  }
}
