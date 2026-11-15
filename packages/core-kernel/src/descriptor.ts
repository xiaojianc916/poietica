import type { CoreModuleDescriptor, CoreModuleDescriptorView } from './module'

const CREATE_TABLE = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi

function tablesOf(descriptor: CoreModuleDescriptor): readonly string[] {
  const names = new Set<string>()
  for (const migration of descriptor.module.migrations ?? []) {
    for (const match of migration.sql.matchAll(CREATE_TABLE)) {
      const name = match[1]
      if (name !== undefined) names.add(name)
    }
  }
  return [...names]
}

/**
 * 把静态描述符与模块的实际声明合成完整视图（§16.4）：RPC 来自契约，表来自迁移，
 * 事件与设置来自模块声明。生成的 featureDescriptors 只提供 id/kind/tier/进程/实现，
 * 其余字段在这里核对，避免再维护一份会漂移的清单。
 */
export function describeCoreModule(descriptor: CoreModuleDescriptor): CoreModuleDescriptorView {
  const module = descriptor.module
  return {
    ...descriptor,
    rpc: {
      methods: (module.contract?.methods ?? []).map((method) => method.name),
      notifications: (module.contract?.notifications ?? []).map((notification) => notification.name),
    },
    events: (module.events ?? []).map((event) => `${event.ownerModule}.${event.name}`),
    tables: tablesOf(descriptor),
    settings: [...(module.settings ?? [])],
  }
}

export function describeCoreModules(descriptors: readonly CoreModuleDescriptor[]): readonly CoreModuleDescriptorView[] {
  return descriptors.map(describeCoreModule)
}
