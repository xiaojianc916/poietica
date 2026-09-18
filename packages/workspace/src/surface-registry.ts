/**
 * 工作区表面的唯一注册处。
 *
 * 表面集合、标题、描述、图标标识、导航次序、实现状态只在此处声明一次；
 * SurfaceId 由本表的键派生，不再另立字面量联合。
 *
 * activation 是这张表最关键的一列：点这一行会发生什么。
 *
 *   surface —— 主区换成这一格。渲染器是强制的，漏一条是编译错误（见 surface.ts）。
 *   planned —— 导航里画得出来，点进去是一张写明「还没实现」的页面。
 *
 * 判别联合而不是两列（status + planned?）：两列之间存在「画面里画得出来却
 * 没有渲染器」这种说不通的组合，而不变量是要靠人记住的东西。这里让它连写都
 * 写不出来。
 *
 * 动作不是表面，所以没有第三种形态。「搜索」曾以 command 形态混在导航里，
 * 现在是标题栏那枚搜索按钮（apps/desktop/src/shell/chrome/title-bar.tsx），
 * 命令本身由命令注册表声明（apps/desktop/src/shell/commands/app-commands.ts）。
 */

export type SurfaceIconId = 'book-open' | 'clock' | 'message' | 'hat-glasses'

export type SurfaceActivation = { readonly kind: 'surface' } | { readonly kind: 'planned' }

export interface SurfaceDescriptor {
  readonly title: string
  readonly description: string
  readonly iconId: SurfaceIconId
  /**
   * 侧边栏导航中的次序。
   *
   * null 表示该表面不出现在导航里。这里刻意不用可选属性：可选属性无法区分
   * "不进导航" 与 "写漏了"，而 as const 之下漏写的那条记录连键都不存在，
   * 读取时会直接编译失败。
   */
  readonly navigationOrder: number | null
  readonly activation: SurfaceActivation
}

export const SURFACE_REGISTRY = {
  ai: {
    title: '新建对话',
    description: '与 AI 协作，驱动工具完成任务。',
    iconId: 'message',
    navigationOrder: null,
    activation: { kind: 'surface' },
  },
  library: {
    title: '资料库',
    description: '应用自己保管的资料：新建或导入 Markdown、表格与网页。',
    iconId: 'book-open',
    navigationOrder: 0,
    activation: { kind: 'surface' },
  },
  automations: {
    title: '自动化',
    description: '按计划反复执行的任务。每次运行都是一条对话。',
    iconId: 'clock',
    navigationOrder: 1,
    activation: { kind: 'surface' },
  },
  personalization: {
    title: '个性化',
    description: '实现Agent的个性化定制。',
    iconId: 'hat-glasses',
    navigationOrder: 2,
    activation: { kind: 'surface' },
  },
} as const satisfies Record<string, SurfaceDescriptor>

export type SurfaceId = keyof typeof SURFACE_REGISTRY

/**
 * 真的画得出来的那些表面。
 *
 * 从 activation.kind 推出来，不是手写的第二份名单：注册表改一个字，这个联合
 * 跟着变，组合根少交一条渲染器立刻编译失败。
 */
export type ReadySurfaceId = {
  [Id in SurfaceId]: (typeof SURFACE_REGISTRY)[Id]['activation']['kind'] extends 'surface'
    ? Id
    : never
}[SurfaceId]

/*
 * as const 之后每条记录都是字面量类型，直接索引取不到接口上的属性。
 * 放宽一次到接口类型，后续读取全部经由这里，避免逐处 as。
 */
const DESCRIPTORS: Record<SurfaceId, SurfaceDescriptor> = SURFACE_REGISTRY

export const DEFAULT_SURFACE_ID: SurfaceId = 'ai'

export function describeSurface(id: SurfaceId): SurfaceDescriptor {
  return DESCRIPTORS[id]
}

export function isSurfaceId(value: string): value is SurfaceId {
  return Object.hasOwn(SURFACE_REGISTRY, value)
}

/* 运行时这一份也从同一张表派生，不存在会跟类型分叉的第二份名单。 */
const READY_SURFACE_IDS: ReadonlySet<string> = new Set(
  Object.entries(DESCRIPTORS)
    .filter(([, descriptor]) => descriptor.activation.kind === 'surface')
    .map(([id]) => id),
)

export function isReadySurfaceId(id: SurfaceId): id is ReadySurfaceId {
  return READY_SURFACE_IDS.has(id)
}

export const SURFACE_NAVIGATION_ORDER: readonly SurfaceId[] = (
  Object.keys(SURFACE_REGISTRY) as SurfaceId[]
)
  .flatMap((id) => {
    const { navigationOrder } = DESCRIPTORS[id]

    return navigationOrder === null ? [] : [{ id, navigationOrder }]
  })
  .sort((left, right) => left.navigationOrder - right.navigationOrder)
  .map((entry) => entry.id)
