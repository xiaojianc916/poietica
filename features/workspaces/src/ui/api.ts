import type { TypedRpcClient } from '@poietica/rpc'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import { type Workspace, workspacesContract } from '../contract'

/** ctx.rpc(workspacesContract) 的薄封装 */
export function createWorkspacesApi(ctx: UiFeatureContext) {
  const rpc: TypedRpcClient<typeof workspacesContract> = ctx.rpc(workspacesContract)
  return {
    list: (): Promise<Workspace[]> =>
      rpc.call('workspaces.list', {}).then((r: { workspaces: Workspace[] }) => r.workspaces),
    add: (path: string): Promise<Workspace> => rpc.call('workspaces.add', { path }),
    createScratch: (): Promise<Workspace> => rpc.call('workspaces.createScratch', {}),
    rename: (workspaceId: string, name: string): Promise<Workspace> =>
      rpc.call('workspaces.rename', { workspaceId, name }),
    remove: (workspaceId: string): Promise<void> =>
      rpc.call('workspaces.remove', { workspaceId }).then(() => undefined),
    touch: (workspaceId: string): Promise<void> => rpc.call('workspaces.touch', { workspaceId }).then(() => undefined),
    onChanged: (l: (p: { workspaces: Workspace[] }) => void) => rpc.on('workspaces.changed', l),
  }
}

export type WorkspacesApi = ReturnType<typeof createWorkspacesApi>
