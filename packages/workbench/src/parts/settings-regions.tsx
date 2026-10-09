import { builtinPoints, FeatureScope, type IconComponent, useContributions, useKernel } from '@poietica/ui-kernel'
import { ArrowLeft } from 'lucide-react'
import { type ReactNode, Suspense, useRef } from 'react'
import { PartSkeleton } from './part-skeleton'

interface NavItem {
  readonly id: string
  readonly group: string
  readonly order: number
  readonly title: string
  readonly icon: IconComponent
}

/*
 * 导航分段（06 页 §6.2「设置导航」）。
 *
 * 外壳只认识**段**：段由 `settingsGroups` 贡献点给出（workbenchFeature 贡献三段），
 * 页归哪一段由贡献这个页的功能用它自己的 `group` 声明。所以这张表里没有、
 * 也不可能有任何 `@poietica/feature-*` 的名字 —— 外壳不认识功能。
 *
 * 段之间只有间距、没有标题（与 legacy `settings-surface.tsx` 的 SECTION_GROUPS 一致：
 * `.settings-navigation__items + .settings-navigation__items` 那条外边距就是它）。
 */
/** 一段导航：一个 `settingsGroups` 条目 + 落在它里面的页（段内按 order）。 */
export interface SettingsNavGroup {
  readonly id: string
  readonly items: readonly NavItem[]
}

/**
 * 把设置页按段切开（06 页 §6.2 的渲染规则）：
 * - 段按 `settingsGroups` 的 order 排序，每段渲染一个 `<nav>`；
 * - 没有页的段不渲染；
 * - `group` 找不到对应段的页进**末尾的兜底段**；
 * - 段内按页的 order 排序。
 *
 * 抽成导出函数是为了单测：这段是「外壳不认识功能」的落点，判据要能脱离渲染直接钉住。
 * 兜底段的 warn 由调用方负责（渲染期不做副作用）。
 */
export function groupSettingsPages(
  groups: readonly { readonly id: string; readonly order: number }[],
  pages: readonly NavItem[],
): readonly SettingsNavGroup[] {
  const sorted = [...pages].sort((a, b) => (a.order === b.order ? (a.id < b.id ? -1 : 1) : a.order - b.order))
  const known = [...groups].sort((a, b) => a.order - b.order)
  const byGroup = new Map<string, NavItem[]>()
  const orphans: NavItem[] = []

  for (const page of sorted) {
    if (!known.some((g) => g.id === page.group)) {
      orphans.push(page)
      continue
    }
    const members = byGroup.get(page.group)
    if (members === undefined) byGroup.set(page.group, [page])
    else members.push(page)
  }

  const out: SettingsNavGroup[] = []

  for (const group of known) {
    const members = byGroup.get(group.id)
    if (members !== undefined && members.length > 0) out.push({ id: group.id, items: members })
  }

  if (orphans.length > 0) out.push({ id: '__unknown__', items: orphans })

  return out
}

/** 兜底段标记（供调用方记 warn 用） */
export const UNKNOWN_SETTINGS_GROUP = '__unknown__'

/**
 * 设置导航。**迁移自** legacy `settings-surface.tsx` 的 SettingsNavigation：
 * 返回键 + 分类列表 + 底部行；类名与结构照旧，数据来源换成 settingsPages 贡献点。
 *
 * 它占的是**外壳的侧栏那一格**（legacy workspace.tsx 的 isSettingsOpen 分支），
 * 不是主区里的一列。
 */
export function SettingsNavigation({
  footer,
  page,
}: {
  readonly footer?: ReactNode
  /**
   * 当前页。组合根（Workbench）给，缺省才回落到读路由 ——
   * 外壳把这两块内容做成稳定引用来避免拖拽时重渲染（见 workbench.tsx 的 useMemo），
   * 而稳定引用同时也要求「换页」这件事必须能从 props 看见，否则子树不会被重画。
   */
  readonly page?: string | undefined
}): ReactNode {
  const pages = useContributions(builtinPoints.settingsPages)
  const groups = useContributions(builtinPoints.settingsGroups)
  const { kernelServices } = useKernel()
  const route = kernelServices.navigation.current().route
  /*
   * 空串要当成「没给」：Workbench 传的是 `route.params.page ?? ''`，而 `''` 不是 nullish，
   * `page ?? route.params.page` 于是留下空串 —— 打开设置（params 为空对象）时 activeId 变成
   * 空串，第一页「通用」拿不到 data-active，导航里没有一行是选中的（真实故障）。
   */
  const wanted = page ?? route.params.page
  const current = wanted === undefined || wanted === '' ? undefined : wanted
  const items: NavItem[] = pages.map((c) => ({
    id: c.item.id,
    group: c.item.group,
    order: c.item.order,
    title: c.item.title,
    icon: c.item.icon,
  }))
  const sections = groupSettingsPages(
    groups.map((c) => c.item),
    items,
  )
  /*
   * group 填错的页（不在 settingsGroups 里）进末尾兜底段，并记一条 warn。
   * 渲染期不做副作用：这里只在首次渲染这个组合时记一次，判据是「这一页 + 这一段」。
   */
  const warned = useRef(new Set<string>())
  for (const section of sections) {
    if (section.id !== UNKNOWN_SETTINGS_GROUP) continue
    for (const item of section.items) {
      const key = `${item.id}@@${item.group}`
      if (warned.current.has(key)) continue
      warned.current.add(key)
      kernelServices.logging.logger.warn('settings page has unknown group', { page: item.id, group: item.group })
    }
  }
  /*
   * 路由没有 page 时选**第一段的第一页**（06 页 §6.2），不是「贡献顺序里的第一个」。
   */
  const firstPageId = sections[0]?.items[0]?.id
  const activeId = route.surface === 'workbench.settings' ? (current ?? firstPageId) : firstPageId

  return (
    <section aria-label="设置分类" className="settings-navigation">
      <button
        className="settings-navigation__back"
        onClick={() => {
          kernelServices.navigation.home()
        }}
        type="button"
      >
        <ArrowLeft aria-hidden="true" className="settings-navigation__icon" />
        <span>返回</span>
      </button>

      <div className="settings-navigation__scroll">
        {sections.map((section) => (
          <nav className="settings-navigation__items" key={section.id}>
            {section.items.map((s) => (
              <button
                aria-current={s.id === activeId ? 'page' : undefined}
                className="settings-navigation__item"
                data-active={s.id === activeId ? 'true' : 'false'}
                data-settings-page={s.id}
                key={s.id}
                onClick={() => {
                  kernelServices.navigation.navigate({ surface: 'workbench.settings', params: { page: s.id } })
                }}
                type="button"
              >
                <s.icon aria-hidden="true" className="settings-navigation__icon" />
                <span>{s.title}</span>
              </button>
            ))}
          </nav>
        ))}
      </div>

      {footer ? <div className="settings-navigation__footer">{footer}</div> : null}
    </section>
  )
}

/**
 * 设置内容区。**迁移自** legacy 的 SettingsContentRegion：内容宽度上限 720px 居中。
 * 作为 surface 注册，所以签名要收 params（06 页 §6.3：路由参数 page 选中页面）。
 */
export function SettingsContentRegion({
  params,
}: {
  readonly params?: Readonly<Record<string, string>>
} = {}): ReactNode {
  const pages = useContributions(builtinPoints.settingsPages)
  const groups = useContributions(builtinPoints.settingsGroups)
  const { kernelServices } = useKernel()
  const route = kernelServices.navigation.current().route
  const pageId = params?.page ?? route.params.page
  /*
   * 缺省页 = **第一段的第一页**（06 页 §6.2），与导航的高亮判据同源：
   * 两处若各自用「贡献顺序里的第一个」，段序一变就会指到不同的页。
   */
  const firstPageId = groupSettingsPages(
    groups.map((c) => c.item),
    pages.map((c) => ({
      id: c.item.id,
      group: c.item.group,
      order: c.item.order,
      title: c.item.title,
      icon: c.item.icon,
    })),
  )[0]?.items[0]?.id
  const active = pages.find((c) => c.item.id === pageId) ?? pages.find((c) => c.item.id === firstPageId)

  if (active === undefined) {
    return (
      <div aria-live="polite" className="settings-content">
        <div className="settings-content__inner">
          <p className="workbench__empty" data-empty="settings-pages">
            还没有任何设置页
          </p>
        </div>
      </div>
    )
  }
  const Component = active.item.component
  return (
    <div aria-live="polite" className="settings-content">
      <div className="settings-content__inner" data-section={active.item.id}>
        <h2 className="settings-content__title">{active.item.title}</h2>
        <FeatureScope featureId={active.featureId} key={active.item.id}>
          <Suspense fallback={<PartSkeleton />}>
            <Component />
          </Suspense>
        </FeatureScope>
      </div>
    </div>
  )
}
