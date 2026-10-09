import { AppError, SystemErrorCode } from './errors'

export interface ModuleNode {
  readonly id: string
  readonly dependsOn?: readonly string[]
}

const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/**
 * 拓扑排序。规则：
 * - id 必须是 kebab-case，且唯一；
 * - dependsOn 引用的模块必须存在于同一份清单里；
 * - 不允许环；
 * - 结果稳定：没有依赖关系的模块之间，保持它们在输入清单中的相对顺序。
 * 任一规则被违反都抛 kernel.module_graph_invalid，message 指出具体模块。
 */
export function sortModules<T extends ModuleNode>(modules: readonly T[]): T[] {
  const byId = new Map<string, T>()
  for (const m of modules) {
    if (!MODULE_ID.test(m.id)) throw invalid(`模块 id 不合法：${m.id}`)
    if (byId.has(m.id)) throw invalid(`模块 id 重复：${m.id}`)
    byId.set(m.id, m)
  }
  for (const m of modules) {
    for (const dep of m.dependsOn ?? []) {
      if (dep === m.id) throw invalid(`模块 ${m.id} 依赖了自己`)
      if (!byId.has(dep)) throw invalid(`模块 ${m.id} 依赖的 ${dep} 不在模块清单中`)
    }
  }
  const result: T[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (m: T, path: readonly string[]): void => {
    const s = state.get(m.id)
    if (s === 'done') return
    if (s === 'visiting') throw invalid(`模块依赖成环：${[...path, m.id].join(' → ')}`)
    state.set(m.id, 'visiting')
    for (const dep of m.dependsOn ?? []) visit(byId.get(dep)!, [...path, m.id])
    state.set(m.id, 'done')
    result.push(m)
  }
  for (const m of modules) visit(m, [])
  return result
}

function invalid(message: string): AppError {
  return new AppError(SystemErrorCode.moduleGraphInvalid, message)
}
