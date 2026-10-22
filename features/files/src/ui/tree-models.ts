import type { FilesApi } from './api'
import { FileTreeModel } from './tree-model'

/**
 * 各工作区的树模型。切走再切回来展开状态还在；工作区从名单里消失时模型一并丢弃（retain），Map 不只增不减。
 */
export class FileTreeModels {
  private readonly models = new Map<string, FileTreeModel>()

  constructor(
    private readonly api: Pick<FilesApi, 'list' | 'search'>,
    private readonly report: (what: string, cause: unknown) => void,
  ) {}

  obtain(workspaceId: string): FileTreeModel {
    const held = this.models.get(workspaceId)
    if (held !== undefined) return held
    const model = new FileTreeModel(workspaceId, this.api, this.report)
    this.models.set(workspaceId, model)
    return model
  }

  peek(workspaceId: string): FileTreeModel | undefined {
    return this.models.get(workspaceId)
  }

  changed(workspaceId: string, paths: readonly string[] | null): void {
    this.models.get(workspaceId)?.changed(paths)
  }

  reloadAll(): void {
    for (const model of this.models.values()) model.reload()
  }

  retain(workspaceIds: ReadonlySet<string>): void {
    for (const [workspaceId, model] of [...this.models]) {
      if (workspaceIds.has(workspaceId)) continue
      this.models.delete(workspaceId)
      model.dispose()
    }
  }
}
