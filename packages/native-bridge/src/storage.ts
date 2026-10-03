import type { StorageGateway, StorageReport } from '@poietica/settings'
import { createStorageMeasurement } from '@poietica/settings'
import { hostBridge } from './host-bridge'

/*
 * 存储那一页的一次测量与两条清理命令。
 *
 * 与 update 同形：命令由宿主自己认（apps/desktop/electron/storage.ts），不进 Rust 的命令
 * 清单 —— 缓存与分区存储是 Electron 的能力，原生侧没有它们。端口在 @poietica/settings 的
 * headless 入口声明（架构闸门只允许宿主集成消费 headless 面），这里按结构满足它。
 *
 * 测量带缓存（两小时）：这一页来回切换不该每次重走一遍数据根。缓存归这一层，是因为
 * 它缓存的是这条 IPC 读的往返，不是页面状态 —— 页面卸载重挂不该把它丢掉。
 */
const measurement = createStorageMeasurement(() => invoke('storage_report'))

export const storageGateway: StorageGateway = {
  report: () => measurement.read(),
  measure: () => measurement.force(),
  clearKernelCache: async () => measurement.accept(await invoke('storage_clear_cache')),
  clearBrowserData: async () => measurement.accept(await invoke('storage_clear_browser_data')),
}

function invoke(command: string): Promise<StorageReport> {
  return hostBridge().invoke(command, null) as Promise<StorageReport>
}
