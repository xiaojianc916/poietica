import type { UiFeatureContext } from '@poietica/ui-kernel'
import { type DirectoryListing, type FileContent, filesContract, type LocatedFile } from '../contract'

/** `ctx.rpc(filesContract)` 的薄封装。 */
export function createFilesApi(ctx: UiFeatureContext) {
  const rpc = ctx.rpc(filesContract)
  return {
    list: (workspaceId: string, path: string): Promise<DirectoryListing> =>
      rpc.call('files.list', { workspaceId, path }),
    read: (workspaceId: string, path: string): Promise<FileContent> => rpc.call('files.read', { workspaceId, path }),
    locate: (workspaceId: string, path: string): Promise<LocatedFile> =>
      rpc.call('files.locate', { workspaceId, path }),
    search: (workspaceId: string, query: string): Promise<{ hits: readonly string[]; truncated: boolean }> =>
      rpc
        .call('files.search', { workspaceId, query })
        .then((found) => ({ hits: found.hits.map((hit) => hit.path), truncated: found.truncated })),
    watch: (workspaceIds: readonly string[]): Promise<void> =>
      rpc.call('files.watch', { workspaceIds: [...workspaceIds] }).then(() => undefined),
    onChanged: (listener: (workspaceId: string, paths: readonly string[] | null) => void) =>
      rpc.on('files.changed', (p) => {
        listener(p.workspaceId, p.paths)
      }),
  }
}

export type FilesApi = ReturnType<typeof createFilesApi>

/** 变了的路径里有没有这一个（paths 为 null = 全变了）。 */
export function touches(paths: readonly string[] | null, path: string): boolean {
  return paths === null || paths.includes(path)
}
