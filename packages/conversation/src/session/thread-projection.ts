import type { ThreadRecord } from '../agent'
import { byRecency, type ThreadListItem, workspaceIdOf } from './thread-order'
import { nameOf } from './thread-title'

export const NO_ITEMS: readonly ThreadListItem[] = []

export class ThreadProjection {
  #items = new Map<string, ThreadListItem>()
  #last: readonly ThreadListItem[] = NO_ITEMS

  of(threads: readonly ThreadRecord[], fallbackWorkspaceId?: string): readonly ThreadListItem[] {
    const listed = [...threads].sort(byRecency)
    const kept = new Map<string, ThreadListItem>()
    const items: ThreadListItem[] = []
    let same = listed.length === this.#last.length
    for (const [index, thread] of listed.entries()) {
      const title = nameOf(thread)
      const isPinned = thread.pinned === true
      const workspaceId = workspaceIdOf(thread, fallbackWorkspaceId)
      const previous = this.#items.get(thread.threadId)
      const item =
        previous !== undefined &&
        previous.title === title &&
        previous.isPinned === isPinned &&
        previous.updatedAt === thread.updatedAt &&
        previous.workspaceId === workspaceId
          ? previous
          : { id: thread.threadId, title, isPinned, updatedAt: thread.updatedAt, workspaceId }
      kept.set(thread.threadId, item)
      items.push(item)
      if (this.#last[index] !== item) {
        same = false
      }
    }
    this.#items = kept
    this.#last = same ? this.#last : items
    return this.#last
  }
}
