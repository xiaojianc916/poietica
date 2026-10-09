import { builtinPoints, FeatureScope, type OverlayItem, useContributions, useKernel } from '@poietica/ui-kernel'
import { type ReactElement, type ReactNode, Suspense, useState } from 'react'
import { PartSkeleton } from './part-skeleton'

/*
 * 页面之上的浮层宿主。
 *
 * 这里原先是外壳栅格里的**横幅行**（`workbench.banners`）：一条横贯整窗的实色条，底色取
 * `--ui-accent`。产品负责人 2026-10-06 决定把它整条删除，两个毛病：
 *
 *   1. **退出时闪一条没有字的色块**。Core 退出走 stopping → stopped，外壳按 `stopped`
 *      立刻挂出这一行（底色照铺满整宽），而贡献的组件因 3 秒宽限画不出字 —— 窗口销毁前
 *      屏幕上只剩一条纯 `#383836`（深色下 `--ui-accent`）的长方形。**外观可见性与组件
 *      内容分家**就是这个故障的根：外壳决定「占一行」，组件决定「有没有字」。
 *   2. **它不是 legacy 的形制**。legacy 的外壳栅格只有两行（页头 / 主体），横幅一律是
 *      design-system 通用 `Banner`：portal 到 body、顶部居中、滑入、自己淡出 —— 不占栅格、
 *      不铺满整宽，也就没有「空行还留着底色」这回事。
 *
 * 于是横幅改回通用 Banner（各功能自己画），这里只剩一个**不占栅格**的浮层宿主：一条贡献
 * 画一个自己的浮层，useVisible 为假时连包装都不挂（与从前的规矩相同）。
 */

/*
 * 包装层**必须 display: contents**（见 parts.css 的 .workbench__overlay）。
 *
 * 这个宿主挂在栅格根节点之内（为了继承 --chrome-height 那类自定义属性），而 .workspace-shell
 * 是 grid —— 一个静态定位的普通 div 会被**自动放进某个格位**，正是「外壳替浮层占一格」
 * 那类形状的翻版。浮层自己 portal / fixed 是脱流的，但包装层留在流里；contents 让它不生成
 * 任何盒子，只留下 data-overlay 这个测试锚。
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

/*
 * 加载失败的功能。06 页 §6.2 的渲染规则表要求「kernel.failures 非空时显示红色
 * 『N 个功能加载失败』，点击弹出列表（功能 id + 错误信息）」。那一条原先住在状态栏左端，
 * 本设计没有状态栏，随后落到横幅区；横幅区删掉之后它回到浮层这一层。
 */
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
