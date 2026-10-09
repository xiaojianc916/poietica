import { useKernel } from '@poietica/ui-kernel'
import type { ReactNode } from 'react'

/**
 * surface 没注册时的占位（功能加载失败 / 已移除）。
 *
 * 文案与结构按 06 页 §6.2：「该页面不可用」，按钮「回到首页」调用 `navigation.home()`。
 */
export function UnknownSurface({ surface }: { readonly surface: string }): ReactNode {
  const { kernelServices } = useKernel()
  return (
    <section className="workbench__unknown" data-surface={surface} data-workbench-part="unknown-surface">
      <div>
        <h1 className="workbench__unknown-title">该页面不可用</h1>
        <p className="workbench__unknown-detail">没有找到「{surface}」这个页面，它所属的功能可能加载失败了。</p>
        <button
          className="workbench__button"
          onClick={() => {
            kernelServices.navigation.home()
          }}
          type="button"
        >
          回到首页
        </button>
      </div>
    </section>
  )
}
