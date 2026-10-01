import { hostBridge } from '../host-bridge'

/*
 * 挑文件与收拖放：宿主对话框与拖放事件的唯一出口。
 *
 * 这里只做运输：过滤器的组装、重复拖放的去重是调用方的语义，不在这里。
 * 读盘发生在原生侧（附件走路径入库），所以这一层只递路径，不碰字节。
 */

export interface FilePickerFilter {
  readonly name: string
  readonly extensions: readonly string[]
}

/** 打一次系统文件选择框。没有选中（人按了取消）返回 null。 */
export async function pickPaths(options: {
  readonly multiple: boolean
  readonly filters: readonly FilePickerFilter[]
}): Promise<readonly string[] | null> {
  const picked = await hostBridge().host.pickPaths({
    multiple: options.multiple,
    filters: options.filters.map((filter) => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
  })

  return picked
}

/**
 * 盯着本窗口的拖放。只递 drop 那一种；同一事件流里的 hover/leave 不出门。
 * 返回摘表函数。
 */
export function watchDroppedPaths(onDrop: (paths: readonly string[]) => void): () => void {
  return hostBridge().host.watchDroppedPaths(onDrop)
}
