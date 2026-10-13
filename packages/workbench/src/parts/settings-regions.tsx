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
 * 外壳只认识**段**：段由 `settingsGroups` 贡献点给出，页归哪一段由贡献这个页的功能用自己的 `group` 声明 ——
 * 所以这张表里不可能有任何 `@poietica/feature-*` 的名字。段之间只有间距、没有标题。
 */
export interface SettingsNavGroup {
  readonly id: string
  readonly items: readonly NavItem[]
}

/**
 * 按段切开设置页：段按 `settingsGroups` 的 order 排，空段不渲染，`group` 找不到对应段的页进末尾兜底段。
 * 抽成导出函数是为了单测能脱离渲染钉住判据；兜底段的 warn 由调用方负责（渲染期不做副作用）。
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

export const UNKNOWN_SETTINGS_GROUP = '__unknown__'

/** 设置导航：返回键 + 分类列表 + 底部行，占外壳的侧栏那一格，不是主区里的一列。 */
export function SettingsNavigation({
  footer,
  page,
}: {
  readonly footer?: ReactNode
  /** 当前页由组合根给：稳定引用要求「换页」必须能从 props 看见，否则子树不会被重画。 */
  readonly page?: string | undefined
}): ReactNode {
  const pages = useContributions(builtinPoints.settingsPages)
  const groups = useContributions(builtinPoints.settingsGroups)
  const { kernelServices } = useKernel()
  const route = kernelServices.navigation.current().route
  /*
   * 空串要当成「没给」：Workbench 传的是 `route.params.page ?? ''`，`page ?? route.params.page` 于是留下空串，
   * activeId 变成空串后第一页拿不到 data-active，导航里没有一行是选中的（真实故障）。
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
  /* 渲染期不做副作用：同一个「页 + 段」只 warn 一次。 */
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
  /* 没有 page 时选第一段的第一页，不是「贡献顺序里的第一个」。 */
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

/** 设置内容区：内容宽度上限 720px 居中；作为 surface 注册，所以签名要收 params。 */
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
  /* 缺省页与导航高亮同源：两处若各自用「贡献顺序里的第一个」，段序一变就会指到不同的页。 */
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
