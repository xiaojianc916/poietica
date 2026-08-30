import type { ReadySurfaceId } from '@poietica/workspace'
import type { ReactNode } from 'react'

/**
 * 表面渲染扩展点。
 *
 * 键是 ReadySurfaceId，不是 SurfaceId，也不是 Partial：
 *
 *   - activation.kind 为 'surface' 的每一条，组合根都必须交出渲染器，漏一条
 *     是编译错误；
 *   - 其余那几条不在这个 Record 里，所以「还没做」不需要一个假渲染器顶着。
 *
 * 不用 Partial<Record<...>>：那会让「还没做」与「写漏了」塌进同一个空位，消费
 * 方只能靠运行时兜底，一个编译期能证明的事实被降级成运行期分支。
 *
 * 所有权：apps 组合根。workspace 只消费，不实现具体业务表面。
 */
export type SurfaceRenderers = Record<ReadySurfaceId, () => ReactNode>
