import type { LayoutService } from '@poietica/ui-kernel'
import { useEffect } from 'react'

/* 表面自己声明当前前台（右坞据此决定在场与否）。**只写不读**，必须写在 effect 里：渲染期写会换布局快照并触发订阅者重画。 */
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
