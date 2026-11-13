import type { ControlsSnapshot } from '@poietica/product-model'
import type { ModelRef, Posture } from '@poietica/runtime-protocol'

export interface ThreadRow {
  id: string
  workspaceId: string
  title: string
  titleSource: 'pending' | 'auto' | 'user'
  posture: Posture
  origin: 'user' | 'automation'
  /**
   * omp 会话 id 与文件路径：库里的 CHECK 要求两者同时为空或同时有值，所以只在这一处一起写
   * （实体上 id 以 sessionId 露出去，供「复制 Session ID」用；文件路径仍然不出这个进程）。
   */
  sessionId: string | null
  sessionFile: string | null
  forkedFrom: string | null
  pinned: boolean
  archived: boolean
  initialModel: ModelRef | null
  initialThinking: string | null
  createdAt: number
  updatedAt: number
}

export interface ThreadsRepository {
  insert(row: ThreadRow): void
  get(id: string): ThreadRow | null
  /** pinned DESC, updated_at DESC */
  list(q: { workspaceId?: string | undefined; includeArchived: boolean }): ThreadRow[]
  update(id: string, patch: Partial<Omit<ThreadRow, 'id'>>): void
  delete(id: string): void
  listByWorkspace(workspaceId: string): ThreadRow[]
  /** 绑着会话文件的那些行（启动对账用：行上的路径必须真有文件） */
  listBound(): Array<{ readonly id: string; readonly sessionFile: string }>
  /** 控件表快照（性能方案 P4，见 controls.ts）：没有、或读不懂都是 null。 */
  controlsSnapshot(id: string): ControlsSnapshot | null
  /** 覆盖控件表快照；内容没变就不写（比较在库里做，进程内不另记一份） */
  saveControlsSnapshot(id: string, snapshot: ControlsSnapshot): void
}
