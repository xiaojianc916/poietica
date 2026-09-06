import { commands } from '@poietica/contract'
import type { OpenedThread, ThreadPort, ThreadSnapshot } from '@poietica/conversation'
import { throughIpc } from '../ipc-error'
import type { AgentBridgeOptions } from './launch-contract'
import { controlOf, goalOf } from './selectors'
import { transcriptPageOf } from './transcript-decoding'

export function createAgentThreadBridge({ launch, cwd }: AgentBridgeOptions): ThreadPort {
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
    export: async (threadId) =>
      throughIpc(async () => commands.agentExportThread({ threadId, launch: await launch() })),
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
