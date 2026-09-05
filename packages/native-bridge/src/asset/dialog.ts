/*
 * 挑文件与收拖放：plugin-dialog 与 webview 事件的唯一出口。
 *
 * 这里只做运输：过滤器的组装、重复拖放的去重是调用方的语义，不在这里。
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
  const { open } = await import('@tauri-apps/plugin-dialog')

  const picked = await open({
    multiple: options.multiple,
    directory: false,
    filters: options.filters.map((filter) => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
  })

  if (picked === null) {
    return null
  }

  return Array.isArray(picked) ? picked : [picked]
}

/**
 * 盯着本窗口的拖放。只递 drop 那一种；同一事件流里的 hover/leave 不出门。
 * 返回摘表函数。
 */
export async function watchDroppedPaths(
  onDrop: (paths: readonly string[]) => void,
): Promise<() => void> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')

  return await getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'drop') {
      onDrop(event.payload.paths)
    }
  })
}
