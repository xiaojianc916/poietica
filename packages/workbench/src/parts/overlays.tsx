import { builtinPoints, FeatureScope, type OverlayItem, useContributions, useKernel } from '@poietica/ui-kernel'
import { type ReactElement, type ReactNode, Suspense, useState } from 'react'
import { PartSkeleton } from './part-skeleton'

/*
 * 浮层宿主。原先是外壳栅格里的横幅行，已整条删除：Core 退出时外壳照铺满整宽的 `--ui-accent` 底色，
 * 而贡献的组件因 3 秒宽限画不出字 —— 窗口销毁前屏幕上只剩一条没有字的色块（真实故障）。
 * 横幅改回 design-system 通用 Banner，由各功能自己 portal。
 */

/*
 * 包装层**必须 display: contents**：宿主挂在栅格根节点之内（为了继承 --chrome-height 那类自定义属性），
 * 而 .workspace-shell 是 grid —— 普通 div 会被自动放进某个格位，等于外壳替浮层占了一格。
 */
function OverlayHost({ item }: { readonly item: OverlayItem }): ReactNode {
  const visible = item.useVisible()
  if (!visible) return null
  const Component = item.component
  return (
    <div className="workbench__overlay" data-overlay={item.id}>
      <Component />
    </div>
  )
}

/* kernel.failures 非空时显示红色「N 个功能加载失败」，点击弹出功能 id + 错误信息。 */
function FailureNotice(): ReactElement | null {
  const { failures } = useKernel()
  const [open, setOpen] = useState(false)
  const failed = [...failures.entries()]
  if (failed.length === 0) return null
  return (
    <div className="workbench__failures" data-workbench-part="failure-notice">
      <button
        className="workbench__failures-button"
        data-feature-failures={failed.length}
        onClick={() => {
          setOpen(!open)
        }}
        type="button"
      >
        {failed.length} 个功能加载失败
      </button>
      {open ? (
        <ul className="workbench__failures-list">
          {failed.map(([id, error]) => (
            <li data-feature-failure={id} key={id}>
              <strong>{id}</strong>：{error.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function Overlays(): ReactElement {
  const overlays = useContributions(builtinPoints.overlays)
  return (
    <>
      <FailureNotice />
      {overlays.map((c) => (
        <FeatureScope featureId={c.featureId} key={c.item.id}>
          <Suspense fallback={<PartSkeleton />}>
            <OverlayHost item={c.item} />
          </Suspense>
        </FeatureScope>
      ))}
    </>
  )
}
