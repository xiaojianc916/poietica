import type { LayoutService } from '@poietica/ui-kernel'
import { useEffect } from 'react'

/*
 * 当前前台的声明：右坞按它决定在场与否（legacy 的 workspace.tsx 由组合根一路传下
 * auxiliaryThread / activeConversationId，这里换成表面自己声明）。
 *
 * **只写不读**，且写成 effect 而不是渲染期：`setActiveOwner` 会换布局快照、触发订阅者
 * 重画，渲染期写它就是在渲染里改别人的状态（React 会警告，StrictMode 下还会转两圈）。
 * 依赖只有 owner 与服务本身，跳页时写一次。
 */
export function ActiveOwner({
  layout,
  owner,
}: {
  readonly layout: LayoutService
  readonly owner: string | null
}): null {
  useEffect(() => {
    layout.setActiveOwner(owner)
  }, [layout, owner])

  return null
}
