/*
 * 存储那一页的端口：一次测量 + 两条清理命令。
 *
 * 住在 headless 入口而不是 ui 域，是因为实现它的是宿主集成（packages/native-bridge/src/storage.ts），
 * 而架构闸门只允许那一侧消费本包的 headless 公开面（headless-host-dependency）。
 * 形状的产地在这里，宿主的实现按结构满足它。
 *
 * 判据是「丢掉之后人会不会少东西」：
 *   safe    内核能从上游重取（HTTP 缓存、代码缓存、着色器缓存）
 *   confirm 站点数据（cookies / localStorage / IndexedDB），清完要重新登录
 */

export type StorageCleanability = 'none' | 'safe' | 'confirm'

export interface StorageEntry {
  readonly id: string
  readonly bytes: number
  readonly cleanable: StorageCleanability
}

export interface StorageReport {
  readonly totalBytes: number
  readonly entries: readonly StorageEntry[]
  /** 扫过的文件数。truncated 为真时字节数是「至少这么多」。 */
  readonly scannedFiles: number
  readonly truncated: boolean
  /** 数完这一刻（Date.now()）：界面照它说「上次测量」，缓存照它判新旧。 */
  readonly measuredAt: number
}

export interface StorageGateway {
  /** 顺手的一次读：新鲜的那一份直接交回，旧了或没有才真的去数（见 ./cache.ts）。 */
  readonly report: () => Promise<StorageReport>
  /** 用户点了「重新测量」：这一次必须是刚数出来的。 */
  readonly measure: () => Promise<StorageReport>
  readonly clearKernelCache: () => Promise<StorageReport>
  readonly clearBrowserData: () => Promise<StorageReport>
}
