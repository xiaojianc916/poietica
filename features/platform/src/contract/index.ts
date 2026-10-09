import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { AppInfo, CoreDiagnostics, FileFilter, LogLevel, StorageEntry, UiLogEntry } from './entities'
import { platformErrors } from './errors'

export * from './entities'
export { platformErrors } from './errors'

const empty = z.object({})
const pathIn = z.object({ path: z.string().min(1) })

/** 本契约中除了两个 diagnostics 之外全部 owner='host' */
const host = { owner: 'host' } as const

export const platformContract = defineContract({
  id: 'platform',
  namespaces: ['app', 'window', 'dialog', 'shell', 'notify', 'log', 'storage', 'diagnostics'],
  methods: [
    defineMethod({ name: 'app.info', ...host, params: empty, result: AppInfo, description: '应用与数据根信息' }),
    defineMethod({ name: 'app.quit', ...host, params: empty, result: empty, description: '走完整退出流程退出应用' }),

    defineMethod({ name: 'window.minimize', ...host, params: empty, result: empty, description: '最小化主窗口' }),
    defineMethod({
      name: 'window.toggleMaximize',
      ...host,
      params: empty,
      result: empty,
      description: '最大化 / 还原主窗口',
    }),
    defineMethod({
      name: 'window.close',
      ...host,
      params: empty,
      result: empty,
      description: '关闭主窗口（会触发关闭拦截）',
    }),
    defineMethod({
      name: 'window.openDevtools',
      ...host,
      params: empty,
      result: empty,
      description: '打开开发者工具（独立窗口）',
    }),
    defineMethod({
      name: 'window.isMaximized',
      ...host,
      params: empty,
      result: z.object({ maximized: z.boolean() }),
      description: '主窗口当前是否最大化',
    }),

    defineMethod({
      name: 'dialog.pickFolder',
      ...host,
      params: z.object({ title: z.string().optional() }),
      result: z.object({ path: z.string().nullable() }),
      timeoutMs: 0,
      description: '选择文件夹；取消返回 null',
    }),
    defineMethod({
      name: 'dialog.pickFiles',
      ...host,
      params: z.object({ filters: z.array(FileFilter).optional(), multiple: z.boolean() }),
      result: z.object({ paths: z.array(z.string()) }),
      timeoutMs: 0,
      description: '选择一个或多个文件；取消返回空数组',
    }),
    defineMethod({
      name: 'dialog.pickSavePath',
      ...host,
      params: z.object({ defaultName: z.string(), filters: z.array(FileFilter).optional() }),
      result: z.object({ path: z.string().nullable() }),
      timeoutMs: 0,
      description: '选择保存路径；取消返回 null',
    }),

    defineMethod({
      name: 'shell.openExternal',
      ...host,
      params: z.object({ url: z.string() }),
      result: empty,
      description: '用系统默认程序打开链接（只放行 http/https/mailto）',
    }),
    defineMethod({
      name: 'shell.openPath',
      ...host,
      params: pathIn,
      result: empty,
      description: '用系统默认程序打开路径',
    }),
    defineMethod({
      name: 'shell.showInFolder',
      ...host,
      params: pathIn,
      result: empty,
      description: '在资源管理器中定位路径',
    }),
    defineMethod({
      name: 'shell.trashItem',
      ...host,
      params: pathIn,
      result: empty,
      description: '把路径移到回收站',
    }),

    defineMethod({
      name: 'notify.show',
      ...host,
      params: z.object({ title: z.string(), body: z.string(), threadId: z.string().optional() }),
      result: empty,
      description: '发系统通知（主窗口聚焦时不弹）',
    }),

    defineMethod({
      name: 'log.write',
      ...host,
      params: z.object({ entries: z.array(UiLogEntry) }),
      result: empty,
      description: '把 UI 日志批量写进主日志',
    }),

    defineMethod({
      name: 'storage.usage',
      ...host,
      params: empty,
      result: z.object({ entries: z.array(StorageEntry) }),
      description: '统计各项存储占用',
    }),
    defineMethod({
      name: 'storage.clear',
      ...host,
      params: z.object({ target: z.enum(['cache', 'logs', 'browser']) }),
      result: z.object({ freedBytes: z.number().int().nonnegative() }),
      description: '清理缓存 / 日志 / 浏览器数据，返回释放的字节数',
    }),
    defineMethod({
      name: 'storage.openDataFolder',
      ...host,
      params: empty,
      result: empty,
      description: '在资源管理器中打开数据根',
    }),

    defineMethod({
      name: 'diagnostics.core',
      owner: 'core',
      params: empty,
      result: CoreDiagnostics,
      description: 'Core 侧的实际目录与版本（隔离证明）',
    }),
    defineMethod({
      name: 'diagnostics.setLogLevel',
      owner: 'core',
      params: z.object({ level: LogLevel }),
      result: empty,
      description: '运行时调整 Core 的日志级别（不落盘）',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'window.maximizedChanged',
      owner: 'host',
      params: z.object({ maximized: z.boolean() }),
      description: '主窗口最大化状态变化',
    }),
    defineNotification({
      name: 'window.closeRequested',
      owner: 'host',
      params: empty,
      description: '用户点了关闭：UI 确认完再调用 app.quit',
    }),
    defineNotification({
      name: 'notify.clicked',
      owner: 'host',
      params: z.object({ threadId: z.string().nullable() }),
      description: '系统通知被点击',
    }),
  ],
  errors: platformErrors,
})
