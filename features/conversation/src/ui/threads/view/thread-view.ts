/*
 * 「项目」组头那三枚按钮里的视图选项（正本 DSH WorkspaceBrowser 的 sectionHeader）：
 * 怎么分组、哪一档归档可见。纯函数在这里，组件只把它们接到屏幕上。
 *
 * 正本的第三组是「排序方式」（手动排序 / 最近更新）。本仓没有拖拽出来的顺序，库里的行序
 * 就是钉住优先、其余按最近活动这一条（threads-store 的 ORDER BY 与 groupByWorkspace 同一条
 * 规则），照抄那一组只会得到两个一模一样的选项 —— 不画。
 */

/** 分组方式。单列表＝不分工作区，按最近活动排成一列（正本 groupBy.flat）。 */
export const GROUP_BY = { workspace: 'workspace', flat: 'flat' } as const
/** 归档会话的可见档：隐藏 / 一起显示 / 只看它们（正本 filterBy 那三档）。 */
export const ARCHIVED_FILTER = { hide: 'hide', show: 'show', only: 'only' } as const

export type GroupBy = (typeof GROUP_BY)[keyof typeof GROUP_BY]
export type ArchivedFilter = (typeof ARCHIVED_FILTER)[keyof typeof ARCHIVED_FILTER]

/** 列表需要的一行：标题用来匹配，其余用来筛与排。 */
export interface ViewThread {
  readonly title: string
  readonly updatedAt: string
  readonly archived?: boolean | undefined
}

export interface ViewGroup<T> {
  readonly id: string
  readonly name: string | null
  readonly items: readonly T[]
}

export interface ViewOptions {
  readonly query: string
  readonly groupBy: GroupBy
  readonly archivedFilter: ArchivedFilter
}

/** 单列表那一档只有一组，名字缺席所以不画组头（列表本来就不画无名组）。 */
export const FLAT_GROUP_ID = '__flat__'

/** 标题里有没有这个词。空词不筛掉任何东西 —— 「搜索框还开着但一个字没打」不等于「什么都不匹配」。 */
export function matchesQuery(title: string, query: string): boolean {
  const needle = query.trim().toLowerCase()

  return needle.length === 0 || title.toLowerCase().includes(needle)
}

function visible(thread: ViewThread, filter: ArchivedFilter): boolean {
  if (filter === ARCHIVED_FILTER.only) {
    return thread.archived === true
  }

  return filter === ARCHIVED_FILTER.show || thread.archived !== true
}

/* ISO-8601 定长串按字典序即时间序（与 thread-order 的 byIsoDescending 同一条规则）。 */
function byUpdatedDescending(left: ViewThread, right: ViewThread): number {
  return left.updatedAt > right.updatedAt ? -1 : left.updatedAt < right.updatedAt ? 1 : 0
}

/**
 * 筛（归档档 + 搜索词）、分组、排序。入参的组序与组内序已经是库里的那一份（组按最近活动、
 * 组内钉住优先），这里只做「换一档视图」那点事：单列表把各组合并重排，其余原样保留。
 */
export function shapeGroups<T extends ViewThread>(
  groups: readonly ViewGroup<T>[],
  options: ViewOptions,
): readonly ViewGroup<T>[] {
  const kept = groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => visible(item, options.archivedFilter) && matchesQuery(item.title, options.query),
      ),
    }))
    .filter((group) => group.items.length > 0)

  if (options.groupBy !== GROUP_BY.flat || kept.length === 0) {
    return kept
  }

  return [
    {
      id: FLAT_GROUP_ID,
      name: null,
      items: kept.flatMap((group) => group.items).sort(byUpdatedDescending),
    },
  ]
}
