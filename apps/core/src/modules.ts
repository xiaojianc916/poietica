export { coreModules, featureDescriptors } from './modules.generated'

import type { RetiredCoreModule } from '@poietica/core-kernel'

/**
 * 已从产品移除、启动时要清掉数据的模块（只增不减：一条记录至少保留到所有用户都升级过一次）。
 * 功能清单本身由 tooling/assembly/core-modules.ts 从 features/<id>/package.json 生成。
 */
export const retiredCoreModules: readonly RetiredCoreModule[] = []
